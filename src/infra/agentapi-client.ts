import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { request } from "node:http";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertUuid } from "../domain/validation";
import { AgCliError } from "../types/protocol";
import { type DaemonCandidate, discoverDaemon, type HealthProbe } from "./daemon-discovery";

const execFileAsync = promisify(execFile);

export interface ProjectSummary {
  id: string;
  name: string;
  folderUris: string[];
}

interface RawProjectResource {
  folderUri?: unknown;
  gitFolder?: { folderUri?: unknown } | null;
}

interface RawProject {
  id?: unknown;
  name?: unknown;
  projectResources?: {
    resources?: unknown;
  } | null;
}

export class AgentApiClient {
  private constructor(
    private readonly daemon: DaemonCandidate,
    private readonly agentapiBin: string,
    private readonly baseEnv: Record<string, string | undefined>,
    private readonly projectId: string | undefined,
    private readonly rpcTimeoutMs: number,
  ) {}

  static async connect(options: {
    antigravityDir: string;
    agentapiBin: string;
    probe?: HealthProbe;
    baseEnv?: Record<string, string | undefined>;
    projectId?: string;
    rpcTimeoutMs?: number;
  }): Promise<AgentApiClient> {
    const daemon = await discoverDaemon(options.antigravityDir, { probe: options.probe });
    let executable = false;
    try {
      accessSync(options.agentapiBin, constants.X_OK);
      executable = true;
    } catch {
      executable = false;
    }
    if (!executable) {
      throw new AgCliError(
        "daemon_unavailable",
        `agentapi binary missing or not executable at ${options.agentapiBin}`,
        { hint: "Install Antigravity or point AG_CLI_AGENTAPI_BIN at a runnable binary." },
      );
    }
    return new AgentApiClient(
      daemon,
      options.agentapiBin,
      options.baseEnv ?? process.env,
      options.projectId,
      options.rpcTimeoutMs ?? 5000,
    );
  }

  private childEnv(projectIdOverride?: string): Record<string, string> {
    const env: Record<string, string> = {};
    const apply = (source: Record<string, string | undefined>): void => {
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === "string") {
          env[key] = value;
        }
      }
    };
    apply(process.env);
    apply(this.baseEnv);
    env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${this.daemon.httpPort}`;
    env.ANTIGRAVITY_CSRF_TOKEN = this.daemon.csrfToken;
    const projectId = projectIdOverride ?? this.projectId;
    if (projectId !== undefined && projectId.length > 0) {
      env.ANTIGRAVITY_PROJECT_ID = projectId;
    } else {
      delete env.ANTIGRAVITY_PROJECT_ID;
    }
    return env;
  }

  private async runAgentapi(args: string[], projectId?: string): Promise<Record<string, unknown>> {
    let stdout = "";
    try {
      const result = await execFileAsync(this.agentapiBin, args, {
        env: this.childEnv(projectId),
        timeout: 15_000,
      });
      stdout = result.stdout;
    } catch (error) {
      const failure = error as { stderr?: string; stdout?: string; message: string };
      const raw = (failure.stderr ?? "").trim() || (failure.stdout ?? "").trim();
      let detail = raw || failure.message;
      try {
        const parsed = JSON.parse(raw) as { error?: string };
        if (typeof parsed.error === "string") {
          detail = parsed.error;
        }
      } catch {
        detail = detail.slice(0, 200);
      }
      throw new AgCliError("runtime_error", `agentapi failed: ${detail}`);
    }
    const trimmed = stdout.trim();
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new AgCliError(
        "runtime_error",
        `agentapi returned non-JSON output: ${trimmed.slice(0, 200)}`,
      );
    }
  }

  async newConversation(input: {
    message: string;
    title?: string;
    profile?: string;
    model?: string;
    projectId?: string;
  }): Promise<{ conversationId: string }> {
    const args = ["new-conversation"];
    if (input.title !== undefined) {
      args.push("--title", input.title);
    }
    if (input.profile !== undefined) {
      args.push("--profile", input.profile);
    }
    if (input.model !== undefined) {
      args.push("--model", input.model);
    }
    args.push("--", input.message);
    const payload = await this.runAgentapi(args, input.projectId);
    const body = unwrapAgentapiResponse(payload, "newConversation");
    const conversationId = body.conversationId;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      throw new AgCliError("runtime_error", `agentapi new-conversation returned no conversationId`);
    }
    return { conversationId: assertUuid(conversationId, "upstream") };
  }

  async sendMessage(
    conversationId: string,
    message: string,
    options: { title?: string; projectId?: string } = {},
  ): Promise<{ conversationId: string; stepIndex?: number }> {
    const args = ["send-message"];
    if (options.title !== undefined) {
      args.push("--title", options.title);
    }
    args.push("--", conversationId, message);
    const payload = await this.runAgentapi(args, options.projectId);
    const body = unwrapAgentapiResponse(payload, "sendMessage");
    const stepIndex = body.stepIndex;
    return { conversationId, ...(typeof stepIndex === "number" ? { stepIndex } : {}) };
  }

  async getConversationMetadata(conversationId: string): Promise<Record<string, unknown>> {
    assertUuid(conversationId, "upstream");
    const payload = await this.runAgentapi(["get-conversation-metadata", conversationId]);
    return unwrapAgentapiResponse(payload, "conversationMetadata");
  }

  private async rpc<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const payload = JSON.stringify(body);
    return new Promise<T>((resolvePromise, rejectOnce) => {
      let settled = false;
      let responseRef: import("node:http").IncomingMessage | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const reject = (error: AgCliError): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadlineTimer);
        rejectOnce(error);
      };
      const resolve = (value: T): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadlineTimer);
        resolvePromise(value);
      };

      const req = request(
        {
          host: "127.0.0.1",
          port: this.daemon.httpPort,
          path: `/exa.language_server_pb.LanguageServerService/${method}`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codeium-csrf-token": this.daemon.csrfToken,
            "content-length": Buffer.byteLength(payload),
          },
        },
        (response) => {
          let raw = "";
          let ended = false;
          response.on("data", (chunk: Buffer) => {
            raw += chunk.toString();
          });
          response.on("aborted", () => {
            reject(
              new AgCliError("runtime_error", `RPC ${method} response aborted before completion`),
            );
          });
          response.on("error", (error: Error) => {
            reject(
              new AgCliError("runtime_error", `RPC ${method} response failed: ${error.message}`),
            );
          });
          response.on("close", () => {
            if (!ended) {
              reject(
                new AgCliError("runtime_error", `RPC ${method} response closed before completion`),
              );
            }
          });
          response.on("end", () => {
            ended = true;
            if (settled) {
              return;
            }
            if (response.statusCode !== 200) {
              reject(
                new AgCliError(
                  "runtime_error",
                  `RPC ${method} failed with status ${response.statusCode}`,
                ),
              );
              return;
            }
            try {
              resolve(raw.length === 0 ? ({} as T) : (JSON.parse(raw) as T));
            } catch {
              reject(new AgCliError("runtime_error", `RPC ${method} returned invalid json`));
            }
          });
        },
      );
      deadlineTimer = setTimeout(() => {
        req.destroy();
        responseRef?.destroy();
        reject(new AgCliError("runtime_error", `RPC ${method} deadline exceeded`));
      }, this.rpcTimeoutMs);
      req.on("response", (response) => {
        responseRef = response;
      });
      req.on("error", (error: Error) => {
        reject(new AgCliError("runtime_error", `RPC ${method} request failed: ${error.message}`));
      });
      req.write(payload);
      req.end();
    });
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const payload = await this.rpc<{ projectIds?: unknown }>("ListProjects", {});
    const ids = Array.isArray(payload.projectIds)
      ? payload.projectIds.filter(
          (id): id is string =>
            typeof id === "string" && id.length > 0 && id !== "outside-of-project",
        )
      : [];
    const loaded = await Promise.all(ids.map((id) => this.readProject(id)));
    return loaded
      .filter((project): project is ProjectSummary => project !== null)
      .sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a.id, b.id));
  }

  async readProject(id: string): Promise<ProjectSummary | null> {
    const payload = await this.rpc<{ project?: RawProject | null }>("ReadProject", { id });
    const raw = payload.project;
    if (raw === null || raw === undefined || typeof raw.id !== "string" || raw.id.length === 0) {
      return null;
    }
    return {
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : "",
      folderUris: extractFolderUris(raw.projectResources?.resources),
    };
  }

  async resolveProject(input: { project?: string; cwd?: string }): Promise<ProjectSummary | null> {
    const projects = await this.listProjects();
    if (input.project !== undefined) {
      const query = input.project.trim();
      if (query.length === 0) {
        throw new AgCliError("invalid_usage", "--project requires a non-empty project id or name");
      }
      const byId = projects.find((project) => project.id === query);
      if (byId !== undefined) {
        return byId;
      }
      const byName = projects.filter((project) => project.name === query);
      if (byName.length === 1) {
        return byName[0] as ProjectSummary;
      }
      if (byName.length > 1) {
        throw new AgCliError(
          "ambiguous_target",
          `multiple Antigravity projects are named ${query}: ${formatProjectCandidates(byName)}`,
          { hint: "Pass --project <id> using the exact UUID from `ag-cli projects`." },
        );
      }
      throw new AgCliError("not_found", `project ${query} not found`, {
        hint: "Run `ag-cli projects` to list registered Antigravity projects.",
      });
    }
    if (input.cwd !== undefined) {
      const target = normalizeFsPath(input.cwd);
      const matches = projects.filter((project) =>
        project.folderUris.some((uri) => decodeFolderUri(uri) === target),
      );
      if (matches.length === 0) {
        return null;
      }
      if (matches.length === 1) {
        return matches[0] as ProjectSummary;
      }
      throw new AgCliError(
        "ambiguous_target",
        `multiple Antigravity projects share ${input.cwd}: ${formatProjectCandidates(matches)}`,
        { hint: "Pass --project <id|name> to disambiguate, or run `ag-cli projects`." },
      );
    }
    return null;
  }

  async cancelCascadeInvocation(conversationId: string): Promise<void> {
    await this.rpc("CancelCascadeInvocation", { cascadeId: conversationId });
  }
}

function extractFolderUris(resources: unknown): string[] {
  if (!Array.isArray(resources)) {
    return [];
  }
  const seen = new Set<string>();
  const uris: string[] = [];
  for (const item of resources) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const resource = item as RawProjectResource;
    const gitUri = resource.gitFolder?.folderUri;
    const directUri = resource.folderUri;
    const candidate =
      typeof gitUri === "string" && gitUri.length > 0
        ? gitUri
        : typeof directUri === "string" && directUri.length > 0
          ? directUri
          : undefined;
    if (candidate !== undefined && !seen.has(candidate)) {
      seen.add(candidate);
      uris.push(candidate);
    }
  }
  return uris;
}

function normalizeFsPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolvePath(value);
  }
}

function decodeFolderUri(uri: string): string | null {
  let decoded = uri;
  if (uri.startsWith("file://")) {
    try {
      decoded = fileURLToPath(uri);
    } catch {
      return null;
    }
  }
  return normalizeFsPath(decoded);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function formatProjectCandidates(projects: ProjectSummary[]): string {
  return projects.map((project) => `${project.name || "(unnamed)"} (${project.id})`).join(", ");
}

function unwrapAgentapiResponse(
  payload: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const response = payload.response;
  if (typeof response === "object" && response !== null) {
    const inner = (response as Record<string, unknown>)[key];
    if (typeof inner === "object" && inner !== null) {
      return inner as Record<string, unknown>;
    }
  }
  return payload;
}
