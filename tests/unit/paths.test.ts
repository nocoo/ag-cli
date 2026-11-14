import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCallerId, resolvePaths } from "../../src/infra/paths";

const USER_HOME = "/home/tester";

describe("resolvePaths", () => {
  it("derives default paths from the user home directory", () => {
    const paths = resolvePaths({}, USER_HOME);

    expect(paths.homeDir).toBe(join(USER_HOME, ".local/share/ag-cli"));
    expect(paths.stateDbPath).toBe(join(USER_HOME, ".local/share/ag-cli/state.db"));
    expect(paths.configDir).toBe(join(USER_HOME, ".config/ag-cli"));
    expect(paths.templatesDir).toBe(join(USER_HOME, ".config/ag-cli/templates"));
    expect(paths.antigravityDir).toBe(join(USER_HOME, ".gemini/antigravity"));
    expect(paths.daemonDir).toBe(join(USER_HOME, ".gemini/antigravity/daemon"));
    expect(paths.summariesDbPath).toBe(
      join(USER_HOME, ".gemini/antigravity/conversation_summaries.db"),
    );
    expect(paths.brainDir).toBe(join(USER_HOME, ".gemini/antigravity/brain"));
    expect(paths.agentapiBin).toBe(join(USER_HOME, ".gemini/antigravity/bin/agentapi"));
  });

  it("honors AG_CLI_HOME for homeDir and stateDbPath", () => {
    const paths = resolvePaths({ AG_CLI_HOME: "/tmp/ag-home" }, USER_HOME);

    expect(paths.homeDir).toBe("/tmp/ag-home");
    expect(paths.stateDbPath).toBe("/tmp/ag-home/state.db");
    expect(paths.configDir).toBe(join(USER_HOME, ".config/ag-cli"));
  });

  it("honors AG_CLI_CONFIG_DIR for configDir and templatesDir", () => {
    const paths = resolvePaths({ AG_CLI_CONFIG_DIR: "/tmp/ag-config" }, USER_HOME);

    expect(paths.configDir).toBe("/tmp/ag-config");
    expect(paths.templatesDir).toBe("/tmp/ag-config/templates");
    expect(paths.homeDir).toBe(join(USER_HOME, ".local/share/ag-cli"));
  });

  it("honors AG_CLI_ANTIGRAVITY_DIR for all antigravity paths", () => {
    const paths = resolvePaths({ AG_CLI_ANTIGRAVITY_DIR: "/tmp/antigravity" }, USER_HOME);

    expect(paths.antigravityDir).toBe("/tmp/antigravity");
    expect(paths.daemonDir).toBe("/tmp/antigravity/daemon");
    expect(paths.summariesDbPath).toBe("/tmp/antigravity/conversation_summaries.db");
    expect(paths.brainDir).toBe("/tmp/antigravity/brain");
    expect(paths.agentapiBin).toBe("/tmp/antigravity/bin/agentapi");
  });

  it("honors AG_CLI_AGENTAPI_BIN overriding the default binary", () => {
    const paths = resolvePaths({ AG_CLI_AGENTAPI_BIN: "/tmp/bin/mock-agentapi" }, USER_HOME);

    expect(paths.agentapiBin).toBe("/tmp/bin/mock-agentapi");
    expect(paths.antigravityDir).toBe(join(USER_HOME, ".gemini/antigravity"));
  });

  it("treats empty environment values as unset", () => {
    const paths = resolvePaths({ AG_CLI_HOME: "", AG_CLI_CONFIG_DIR: "" }, USER_HOME);

    expect(paths.homeDir).toBe(join(USER_HOME, ".local/share/ag-cli"));
    expect(paths.configDir).toBe(join(USER_HOME, ".config/ag-cli"));
  });

  it("falls back to process.env and os.homedir() when arguments are omitted", () => {
    const paths = resolvePaths();

    expect(paths.homeDir).toBe(join(homedir(), ".local/share/ag-cli"));
    expect(paths.antigravityDir).toBe(join(homedir(), ".gemini/antigravity"));
  });
});

describe("resolveCallerId", () => {
  it("returns undefined when no caller environment is set", () => {
    expect(resolveCallerId({})).toBeUndefined();
  });

  it("prefers AG_CLI_CALLER_ID over ANTIGRAVITY_CONVERSATION_ID", () => {
    expect(
      resolveCallerId({
        AG_CLI_CALLER_ID: "11111111-1111-4111-8111-111111111111",
        ANTIGRAVITY_CONVERSATION_ID: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("falls back to ANTIGRAVITY_CONVERSATION_ID", () => {
    expect(
      resolveCallerId({ ANTIGRAVITY_CONVERSATION_ID: "22222222-2222-4222-8222-222222222222" }),
    ).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("treats an empty AG_CLI_CALLER_ID as unset", () => {
    expect(
      resolveCallerId({
        AG_CLI_CALLER_ID: "",
        ANTIGRAVITY_CONVERSATION_ID: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe("22222222-2222-4222-8222-222222222222");
  });
});
