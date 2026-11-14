import { accessSync, constants, existsSync } from "node:fs";
import { inspectDaemons } from "../../infra/daemon-discovery";
import { resolvePaths } from "../../infra/paths";
import { openSummariesReader } from "../../infra/summaries-reader";
import { emitJson, emitText, resolveMode, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";

export interface StatusPayload {
  daemon: {
    healthy: boolean;
    pid?: number;
    httpPort?: number;
    lsVersion?: string;
    hubFile?: string;
    problems: string[];
  };
  summaries: { readable: boolean; conversations: number };
  agentapi: { present: boolean; executable: boolean; path: string };
  stateDb: { present: boolean; path: string };
}

export async function runStatusCommand(
  args: string[],
  context: { env: Record<string, string | undefined>; stdout: StreamLike },
): Promise<number> {
  const flags = parseCommandFlags(args, { booleans: ["json"], values: [] });
  const paths = resolvePaths(context.env);

  const candidates = await inspectDaemons(paths.antigravityDir);
  const healthy = candidates.find(
    (candidate) => candidate.parseError === undefined && candidate.pidAlive && candidate.healthz,
  );
  const daemon: StatusPayload["daemon"] = {
    healthy: healthy !== undefined,
    ...(healthy === undefined
      ? {}
      : {
          pid: healthy.pid,
          httpPort: healthy.httpPort,
          lsVersion: healthy.lsVersion,
          hubFile: healthy.hubFile,
        }),
    problems: candidates.map(
      (candidate) =>
        `${candidate.hubFile}: ${candidate.parseError ?? (candidate.pidAlive ? "unreachable /healthz" : "dead pid")}`,
    ),
  };

  const reader = openSummariesReader(paths.summariesDbPath);
  let conversations = 0;
  if (reader !== null) {
    conversations = reader.listConversations().length;
    reader.close();
  }

  const agentapi = {
    present: existsSync(paths.agentapiBin),
    executable: false,
    path: paths.agentapiBin,
  };
  if (agentapi.present) {
    try {
      accessSync(paths.agentapiBin, constants.X_OK);
      agentapi.executable = true;
    } catch {
      agentapi.executable = false;
    }
  }

  const payload: StatusPayload = {
    daemon,
    summaries: { readable: reader !== null, conversations },
    agentapi,
    stateDb: { present: existsSync(paths.stateDbPath), path: paths.stateDbPath },
  };

  const mode = resolveMode({
    json: flags.flags.has("json"),
    tty: context.stdout.isTTY === true,
    pipedIsJson: true,
  });
  if (mode === "json") {
    emitJson(context.stdout, payload);
  } else {
    emitText(
      context.stdout,
      [
        healthy === undefined
          ? "daemon: no healthy language_server found"
          : `daemon: healthy (pid ${healthy.pid}, port ${healthy.httpPort}, ls ${healthy.lsVersion})`,
        ...daemon.problems.map((problem) => `  problem: ${problem}`),
        `summaries: ${payload.summaries.readable ? `readable (${conversations} conversations)` : "missing"}`,
        `agentapi: ${agentapi.present && agentapi.executable ? "present and executable" : agentapi.present ? "present but not executable" : "missing"} (${agentapi.path})`,
        `state.db: ${payload.stateDb.present ? "present" : "not initialized"} (${payload.stateDb.path})`,
      ].join("\n"),
    );
  }
  return 0;
}
