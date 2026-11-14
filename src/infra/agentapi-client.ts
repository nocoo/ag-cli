import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { request } from "node:http";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertUuid } from "../domain/validation";
import { NullgError } from "../types/protocol";
import { type DaemonCandidate, discoverDaemon, type HealthProbe } from "./daemon-discovery";

const execFileAsync = promisify(execFile);

export interface ProjectSummary {
  projectId?: string;
  folderUri?: string;
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
      throw new NullgError(
        "daemon_unavailable",
        `agentapi binary missing or not executable at ${options.agentapiBin}`,
        { hint: "Install Antigravity or point NULLG_AGENTAPI_BIN at a runnable binary." },
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
      throw new NullgError("runtime_error", `agentapi failed: ${detail}`);
    }
    const trimmed = stdout.trim();
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new NullgError(
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
    const args = ["new-conversation", "--message", input.message];
    if (input.title !== undefined) {
      args.push("--title", input.title);
    }
    if (input.profile !== undefined) {
      args.push("--profile", input.profile);
    }
    if (input.model !== undefined) {
      args.push("--model", input.model);
    }
    const payload = await this.runAgentapi(args, input.projectId);
    const conversationId = payload.conversationId;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      throw new NullgError("runtime_error", `agentapi new-conversation returned no conversationId`);
    }
    return { conversationId: assertUuid(conversationId, "upstream") };
  }

  async sendMessage(
    conversationId: string,
    message: string,
    options: { title?: string; projectId?: string } = {},
  ): Promise<{ conversationId: string; stepIndex?: number }> {
    const args = ["send-message", "--conversation-id", conversationId, "--message", message];
    if (options.title !== undefined) {
      args.push("--title", options.title);
    }
    const payload = await this.runAgentapi(args, options.projectId);
    const stepIndex = payload.stepIndex;
    return { conversationId, ...(typeof stepIndex === "number" ? { stepIndex } : {}) };
  }

  async getConversationMetadata(conversationId: string): Promise<Record<string, unknown>> {
    assertUuid(conversationId, "upstream");
    return this.runAgentapi(["get-conversation-metadata", "--conversation-id", conversationId]);
  }

  private async rpc<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const payload = JSON.stringify(body);
    return new Promise<T>((resolvePromise, rejectOnce) => {
      let settled = false;
      let responseRef: import("node:http").IncomingMessage | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const reject = (error: NullgError): void => {
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
              new NullgError("runtime_error", `RPC ${method} response aborted before completion`),
            );
          });
          response.on("error", (error: Error) => {
            reject(
              new NullgError("runtime_error", `RPC ${method} response failed: ${error.message}`),
            );
          });
          response.on("close", () => {
            if (!ended) {
              reject(
                new NullgError("runtime_error", `RPC ${method} response closed before completion`),
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
                new NullgError(
                  "runtime_error",
                  `RPC ${method} failed with status ${response.statusCode}`,
                ),
              );
              return;
            }
            try {
              resolve(raw.length === 0 ? ({} as T) : (JSON.parse(raw) as T));
            } catch {
              reject(new NullgError("runtime_error", `RPC ${method} returned invalid json`));
            }
          });
        },
      );
      deadlineTimer = setTimeout(() => {
        req.destroy();
        responseRef?.destroy();
        reject(new NullgError("runtime_error", `RPC ${method} deadline exceeded`));
      }, this.rpcTimeoutMs);
      req.on("response", (response) => {
        responseRef = response;
      });
      req.on("error", (error: Error) => {
        reject(new NullgError("runtime_error", `RPC ${method} request failed: ${error.message}`));
      });
      req.write(payload);
      req.end();
    });
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const payload = await this.rpc<{ projects?: ProjectSummary[] }>("ListProjects", {});
    return payload.projects ?? [];
  }

  async readProject(projectId: string): Promise<ProjectSummary | null> {
    const payload = await this.rpc<{ project?: ProjectSummary | null }>("ReadProject", {
      projectId,
    });
    return payload.project ?? null;
  }

  async resolveProjectIdForCwd(cwd: string): Promise<string | null> {
    const projects = await this.listProjects();
    const normalize = (value: string): string => {
      try {
        return realpathSync(value);
      } catch {
        return resolvePath(value);
      }
    };
    const target = normalize(cwd);
    const match = projects.find((project) => {
      const folder = project.folderUri ?? "";
      if (folder.length === 0) {
        return false;
      }
      let decoded = folder;
      if (folder.startsWith("file://")) {
        try {
          decoded = fileURLToPath(folder);
        } catch {
          return false;
        }
      }
      return normalize(decoded) === target;
    });
    return match?.projectId ?? null;
  }

  async cancelCascadeInvocation(conversationId: string): Promise<void> {
    await this.rpc("CancelCascadeInvocation", { conversationId });
  }
}
