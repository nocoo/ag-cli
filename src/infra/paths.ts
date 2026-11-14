import { homedir } from "node:os";
import { join } from "node:path";

export type PathEnv = Record<string, string | undefined>;

export interface ResolvedPaths {
  homeDir: string;
  stateDbPath: string;
  configDir: string;
  templatesDir: string;
  antigravityDir: string;
  daemonDir: string;
  summariesDbPath: string;
  brainDir: string;
  agentapiBin: string;
}

function pick(env: PathEnv, key: string): string | undefined {
  const value = env[key];
  return value ? value : undefined;
}

export function resolvePaths(
  env: PathEnv = process.env,
  homeDir: string = homedir(),
): ResolvedPaths {
  const agHome = pick(env, "AG_CLI_HOME") ?? join(homeDir, ".local/share/ag-cli");
  const configDir = pick(env, "AG_CLI_CONFIG_DIR") ?? join(homeDir, ".config/ag-cli");
  const antigravityDir =
    pick(env, "AG_CLI_ANTIGRAVITY_DIR") ?? join(homeDir, ".gemini/antigravity");

  return {
    homeDir: agHome,
    stateDbPath: join(agHome, "state.db"),
    configDir,
    templatesDir: join(configDir, "templates"),
    antigravityDir,
    daemonDir: join(antigravityDir, "daemon"),
    summariesDbPath: join(antigravityDir, "conversation_summaries.db"),
    brainDir: join(antigravityDir, "brain"),
    agentapiBin: pick(env, "AG_CLI_AGENTAPI_BIN") ?? join(antigravityDir, "bin/agentapi"),
  };
}

export function resolveCallerId(env: PathEnv = process.env): string | undefined {
  return pick(env, "AG_CLI_CALLER_ID") ?? pick(env, "ANTIGRAVITY_CONVERSATION_ID");
}
