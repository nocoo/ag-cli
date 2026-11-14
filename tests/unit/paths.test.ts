import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCallerId, resolvePaths } from "../../src/infra/paths";

const USER_HOME = "/home/tester";

describe("resolvePaths", () => {
  it("derives default paths from the user home directory", () => {
    const paths = resolvePaths({}, USER_HOME);

    expect(paths.homeDir).toBe(join(USER_HOME, ".local/share/nullg"));
    expect(paths.stateDbPath).toBe(join(USER_HOME, ".local/share/nullg/state.db"));
    expect(paths.configDir).toBe(join(USER_HOME, ".config/nullg"));
    expect(paths.templatesDir).toBe(join(USER_HOME, ".config/nullg/templates"));
    expect(paths.antigravityDir).toBe(join(USER_HOME, ".gemini/antigravity"));
    expect(paths.daemonDir).toBe(join(USER_HOME, ".gemini/antigravity/daemon"));
    expect(paths.summariesDbPath).toBe(
      join(USER_HOME, ".gemini/antigravity/conversation_summaries.db"),
    );
    expect(paths.brainDir).toBe(join(USER_HOME, ".gemini/antigravity/brain"));
    expect(paths.agentapiBin).toBe(join(USER_HOME, ".gemini/antigravity/bin/agentapi"));
  });

  it("honors NULLG_HOME for homeDir and stateDbPath", () => {
    const paths = resolvePaths({ NULLG_HOME: "/tmp/ag-home" }, USER_HOME);

    expect(paths.homeDir).toBe("/tmp/ag-home");
    expect(paths.stateDbPath).toBe("/tmp/ag-home/state.db");
    expect(paths.configDir).toBe(join(USER_HOME, ".config/nullg"));
  });

  it("honors NULLG_CONFIG_DIR for configDir and templatesDir", () => {
    const paths = resolvePaths({ NULLG_CONFIG_DIR: "/tmp/ag-config" }, USER_HOME);

    expect(paths.configDir).toBe("/tmp/ag-config");
    expect(paths.templatesDir).toBe("/tmp/ag-config/templates");
    expect(paths.homeDir).toBe(join(USER_HOME, ".local/share/nullg"));
  });

  it("honors NULLG_ANTIGRAVITY_DIR for all antigravity paths", () => {
    const paths = resolvePaths({ NULLG_ANTIGRAVITY_DIR: "/tmp/antigravity" }, USER_HOME);

    expect(paths.antigravityDir).toBe("/tmp/antigravity");
    expect(paths.daemonDir).toBe("/tmp/antigravity/daemon");
    expect(paths.summariesDbPath).toBe("/tmp/antigravity/conversation_summaries.db");
    expect(paths.brainDir).toBe("/tmp/antigravity/brain");
    expect(paths.agentapiBin).toBe("/tmp/antigravity/bin/agentapi");
  });

  it("honors NULLG_AGENTAPI_BIN overriding the default binary", () => {
    const paths = resolvePaths({ NULLG_AGENTAPI_BIN: "/tmp/bin/mock-agentapi" }, USER_HOME);

    expect(paths.agentapiBin).toBe("/tmp/bin/mock-agentapi");
    expect(paths.antigravityDir).toBe(join(USER_HOME, ".gemini/antigravity"));
  });

  it("treats empty environment values as unset", () => {
    const paths = resolvePaths({ NULLG_HOME: "", NULLG_CONFIG_DIR: "" }, USER_HOME);

    expect(paths.homeDir).toBe(join(USER_HOME, ".local/share/nullg"));
    expect(paths.configDir).toBe(join(USER_HOME, ".config/nullg"));
  });

  it("falls back to process.env and os.homedir() when arguments are omitted", () => {
    const paths = resolvePaths();

    expect(paths.homeDir).toBe(join(homedir(), ".local/share/nullg"));
    expect(paths.antigravityDir).toBe(join(homedir(), ".gemini/antigravity"));
  });
});

describe("resolveCallerId", () => {
  it("returns undefined when no caller environment is set", () => {
    expect(resolveCallerId({})).toBeUndefined();
  });

  it("prefers NULLG_CALLER_ID over ANTIGRAVITY_CONVERSATION_ID", () => {
    expect(
      resolveCallerId({
        NULLG_CALLER_ID: "11111111-1111-4111-8111-111111111111",
        ANTIGRAVITY_CONVERSATION_ID: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("falls back to ANTIGRAVITY_CONVERSATION_ID", () => {
    expect(
      resolveCallerId({ ANTIGRAVITY_CONVERSATION_ID: "22222222-2222-4222-8222-222222222222" }),
    ).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("treats an empty NULLG_CALLER_ID as unset", () => {
    expect(
      resolveCallerId({
        NULLG_CALLER_ID: "",
        ANTIGRAVITY_CONVERSATION_ID: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe("22222222-2222-4222-8222-222222222222");
  });
});
