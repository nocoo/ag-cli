import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSandbox,
  initSummariesDb,
  readTranscript,
  runAgentapi,
  type Sandbox,
  startMockLanguageServer,
  transcriptPath,
  writeHubFile,
  writeMockAgentapi,
} from "../helpers/sandbox";

const active: Sandbox[] = [];

function sandbox(): Sandbox {
  const created = createSandbox();
  active.push(created);
  return created;
}

afterEach(() => {
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

describe("createSandbox", () => {
  it("creates isolated directories and environment variables", () => {
    const instance = sandbox();

    expect(instance.agCliHome.startsWith(instance.root)).toBe(true);
    expect(instance.configDir.startsWith(instance.root)).toBe(true);
    expect(instance.antigravityDir.startsWith(instance.root)).toBe(true);
    expect(instance.agentapiBin.startsWith(instance.root)).toBe(true);

    expect(existsSync(join(instance.agCliHome, "state.db"))).toBe(false);
    expect(existsSync(instance.daemonDir)).toBe(true);
    expect(existsSync(instance.brainDir)).toBe(true);
    expect(existsSync(instance.summariesDbPath)).toBe(false);

    expect(instance.env).toEqual({
      AG_CLI_HOME: instance.agCliHome,
      AG_CLI_CONFIG_DIR: instance.configDir,
      AG_CLI_ANTIGRAVITY_DIR: instance.antigravityDir,
      AG_CLI_AGENTAPI_BIN: instance.agentapiBin,
    });
  });

  it("cleans up the temporary root", () => {
    const instance = sandbox();
    const root = instance.root;
    instance.cleanup();
    expect(existsSync(root)).toBe(false);
  });
});

describe("writeHubFile", () => {
  it("writes a hub_<port>.json daemon discovery credential", () => {
    const instance = sandbox();
    const path = writeHubFile(instance, {
      pid: 4242,
      httpPort: 8123,
      httpsPort: 8124,
      lsVersion: "1.2.3",
      csrfToken: "token-abc",
    });

    expect(path).toBe(join(instance.daemonDir, "hub_8123.json"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      pid: 4242,
      httpPort: 8123,
      httpsPort: 8124,
      lsVersion: "1.2.3",
      csrfToken: "token-abc",
    });
  });
});

describe("startMockLanguageServer", () => {
  it("serves /healthz, language server RPCs, and records requests", async () => {
    const mock = await startMockLanguageServer();
    try {
      expect(mock.port).toBeGreaterThan(0);
      expect(mock.csrfToken).not.toBe("");
      const base = `http://127.0.0.1:${mock.port}`;

      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const rpc = await fetch(
        `${base}/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation`,
        { method: "POST", body: "{}" },
      );
      expect(rpc.status).toBe(200);

      const missing = await fetch(`${base}/nope`);
      expect(missing.status).toBe(404);

      expect(mock.requests.map((entry) => entry.url)).toContain("/healthz");
    } finally {
      await mock.close();
    }
  });
});

describe("initSummariesDb", () => {
  it("creates a WAL conversation_summaries database", () => {
    const instance = sandbox();
    const db = initSummariesDb(instance);

    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode.toLowerCase()).toBe("wal");

    db.prepare("INSERT INTO conversation_summaries (conversation_id, title) VALUES (?, ?)").run(
      "11111111-1111-4111-8111-111111111111",
      "first",
    );
    const row = db
      .prepare(
        "SELECT conversation_id, status, killed FROM conversation_summaries WHERE conversation_id = ?",
      )
      .get("11111111-1111-4111-8111-111111111111") as {
      conversation_id: string;
      status: string;
      killed: number;
    };
    expect(row.conversation_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(row.status).toBe("CASCADE_RUN_STATUS_IDLE");
    expect(row.killed).toBe(0);
    db.close();
  });
});

describe("writeMockAgentapi", () => {
  it("generates an executable mock agentapi binary", () => {
    const instance = sandbox();
    const path = writeMockAgentapi(instance);

    expect(path).toBe(instance.agentapiBin);
    accessSync(path, constants.X_OK);
  });

  it("new-conversation appends a realistic transcript and summary row", () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);

    const result = runAgentapi(instance, [
      "new-conversation",
      "--title",
      "deps fix",
      "upgrade deps",
    ]);
    expect(result.status).toBe(0);

    const payload = JSON.parse(result.stdout) as { conversationId: string };
    const steps = readTranscript(instance, payload.conversationId);
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps[0]).toMatchObject({ step_index: 0, type: "USER_INPUT", status: "DONE" });
    expect(steps.at(-1)).toMatchObject({ type: "PLANNER_RESPONSE", status: "DONE" });

    const db = initSummariesDb(instance);
    const row = db
      .prepare(
        "SELECT step_count, status, not_fully_idle FROM conversation_summaries WHERE conversation_id = ?",
      )
      .get(payload.conversationId) as {
      step_count: number;
      status: string;
      not_fully_idle: number;
    };
    db.close();
    expect(row.step_count).toBe(steps.length);
    expect(row.status).toBe("CASCADE_RUN_STATUS_IDLE");
    expect(row.not_fully_idle).toBe(0);
  });

  it("send-message appends a new turn past the previous watermark", () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);

    const created = runAgentapi(instance, ["new-conversation", "first"]);
    const { conversationId } = JSON.parse(created.stdout) as { conversationId: string };

    const sent = runAgentapi(instance, ["send-message", conversationId, "second turn"]);
    expect(sent.status).toBe(0);

    const steps = readTranscript(instance, conversationId);
    const userSteps = steps.filter((step) => step.type === "USER_INPUT");
    expect(userSteps.length).toBe(2);
    expect(steps.at(-1)).toMatchObject({ type: "PLANNER_RESPONSE", status: "DONE" });
  });

  it("get-conversation-metadata prints the summary row", () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);

    const created = runAgentapi(instance, ["new-conversation", "--title", "meta check", "hi"]);
    const { conversationId } = JSON.parse(created.stdout) as { conversationId: string };

    const result = runAgentapi(instance, ["get-conversation-metadata", conversationId]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      response: {
        conversationMetadata: {
          metadata: {
            conversation_id: conversationId,
            title: "meta check",
          },
        },
      },
    });
  });

  it("honors the blocked mode for ask_question turns", () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);

    const created = runAgentapi(instance, ["new-conversation", "needs approval"], {
      AG_MOCK_AGENTAPI_MODE: "blocked",
    });
    const { conversationId } = JSON.parse(created.stdout) as { conversationId: string };

    const steps = readTranscript(instance, conversationId);
    expect(steps.at(-1)).toMatchObject({ status: "WAITING" });
    expect(JSON.stringify(steps.at(-1))).toContain("ask_question");

    const db = initSummariesDb(instance);
    const row = db
      .prepare(
        "SELECT status, not_fully_idle FROM conversation_summaries WHERE conversation_id = ?",
      )
      .get(conversationId) as { status: string; not_fully_idle: number };
    db.close();
    expect(row.status).toBe("CASCADE_RUN_STATUS_RUNNING");
    expect(row.not_fully_idle).toBe(1);
  });

  it("exposes the transcript path helper", () => {
    const instance = sandbox();
    expect(transcriptPath(instance, "990014f6-f6d1-4567-adcf-6182cead394c")).toBe(
      join(
        instance.brainDir,
        "990014f6-f6d1-4567-adcf-6182cead394c",
        ".system_generated",
        "logs",
        "transcript.jsonl",
      ),
    );
  });
});
