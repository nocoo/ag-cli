import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { promisify } from "node:util";
import { AgCliError } from "../types/protocol";
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
  ) {}

  static async connect(options: {
    antigravityDir: string;
    agentapiBin: string;
    probe?: HealthProbe;
    baseEnv?: Record<string, string | undefined>;
    projectId?: string;
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
    );
  }

  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.baseEnv)) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }
    env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${this.daemon.httpPort}`;
    env.ANTIGRAVITY_CSRF_TOKEN = this.daemon.csrfToken;
    if (this.projectId !== undefined && this.projectId.length > 0) {
      env.ANTIGRAVITY_PROJECT_ID = this.projectId;
    }
    return env;
  }

  private async runAgentapi(args: string[]): Promise<Record<string, unknown>> {
    let stdout = "";
    try {
      const result = await execFileAsync(this.agentapiBin, args, {
        env: this.childEnv(),
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
  }): Promise<{ conversationId: string }> {
    const args = ["new-conversation", "--message", input.message];
    if (input.title !== undefined) {
      args.push("--title", input.title);
    }
    if (input.profile !== undefined) {
      args.push("--profile", input.profile);
    }
    const payload = await this.runAgentapi(args);
    const conversationId = payload.conversationId;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      throw new AgCliError("runtime_error", `agentapi new-conversation returned no conversationId`);
    }
    return { conversationId };
  }

  async sendMessage(
    conversationId: string,
    message: string,
    options: { title?: string } = {},
  ): Promise<{ conversationId: string; stepIndex?: number }> {
    const args = ["send-message", "--conversation-id", conversationId, "--message", message];
    if (options.title !== undefined) {
      args.push("--title", options.title);
    }
    const payload = await this.runAgentapi(args);
    return {
      conversationId,
      ...(typeof payload.stepIndex === "number" ? { stepIndex: payload.stepIndex } : {}),
    };
  }

  async getConversationMetadata(conversationId: string): Promise<Record<string, unknown>> {
    return this.runAgentapi(["get-conversation-metadata", "--conversation-id", conversationId]);
  }

  private async rpc<T>(method: string, body: unknown): Promise<T> {
    const url = `http://127.0.0.1:${this.daemon.httpPort}/exa.language_server_pb.LanguageServerService/${method}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codeium-csrf-token": this.daemon.csrfToken,
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new AgCliError(
        "runtime_error",
        `RPC ${method} request failed: ${(error as Error).message}`,
      );
    }
    if (response.status !== 200) {
      throw new AgCliError("runtime_error", `RPC ${method} failed with status ${response.status}`);
    }
    return (await response.json()) as T;
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
    const match = projects.find((project) => {
      const folder = project.folderUri ?? "";
      return (
        folder === cwd || folder === `file://${cwd}` || folder.replace(/^file:\/\//, "") === cwd
      );
    });
    return match?.projectId ?? null;
  }

  async cancelCascadeInvocation(conversationId: string): Promise<void> {
    await this.rpc("CancelCascadeInvocation", { conversationId });
  }
}
