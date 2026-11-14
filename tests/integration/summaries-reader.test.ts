import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { listBrainArtifacts, openSummariesReader } from "../../src/infra/summaries-reader";
import {
  createSandbox,
  initSummariesDb,
  runAgentapi,
  type Sandbox,
  writeMockAgentapi,
} from "../helpers/sandbox";

const active: Sandbox[] = [];

function sandbox(): Sandbox {
  const created = createSandbox("ag-cli-int-summaries");
  active.push(created);
  return created;
}

afterEach(() => {
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("openSummariesReader", () => {
  it("returns null when the database does not exist yet", () => {
    const instance = sandbox();
    expect(openSummariesReader(instance.summariesDbPath)).toBeNull();
  });

  it("opens an existing summaries database and closes cleanly", () => {
    const instance = sandbox();
    initSummariesDb(instance);

    const reader = openSummariesReader(instance.summariesDbPath);
    expect(reader).not.toBeNull();
    reader?.close();
  });
});

describe("SummariesReader queries", () => {
  it("lists conversations ordered by last modified time descending", () => {
    const instance = sandbox();
    const writer = initSummariesDb(instance);
    writer
      .prepare(
        "INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, step_count, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run(UUID_A, "older", "2026-11-14T01:00:00Z", 3, "CASCADE_RUN_STATUS_IDLE");
    writer
      .prepare(
        "INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, step_count, status, not_fully_idle, killed) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(UUID_B, "newer", "2026-11-14T02:00:00Z", 7, "CASCADE_RUN_STATUS_RUNNING", 1, 0);
    writer.close();

    const reader = openSummariesReader(instance.summariesDbPath);
    expect(reader).not.toBeNull();
    try {
      const rows = reader?.listConversations() ?? [];
      expect(rows.map((row) => row.conversation_id)).toEqual([UUID_B, UUID_A]);
      expect(rows[0]).toMatchObject({
        title: "newer",
        step_count: 7,
        status: "CASCADE_RUN_STATUS_RUNNING",
        not_fully_idle: 1,
        killed: 0,
      });

      expect(reader?.getConversation(UUID_A)).toMatchObject({
        conversation_id: UUID_A,
        title: "older",
      });
      expect(reader?.getConversation("cccccccc-cccc-4ccc-8ccc-cccccccccccc")).toBeUndefined();
    } finally {
      reader?.close();
    }
  });

  it("reads rows written by the mock agentapi through a WAL database", () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);

    const created = runAgentapi(instance, [
      "new-conversation",
      "--title",
      "wal check",
      "--message",
      "hi",
    ]);
    expect(created.status).toBe(0);
    const { conversationId } = JSON.parse(created.stdout) as { conversationId: string };

    const reader = openSummariesReader(instance.summariesDbPath);
    try {
      expect(reader?.getConversation(conversationId)).toMatchObject({
        conversation_id: conversationId,
        title: "wal check",
        status: "CASCADE_RUN_STATUS_IDLE",
        not_fully_idle: 0,
      });
    } finally {
      reader?.close();
    }
  });

  it("rejects writes on read-only sqlite connections", () => {
    const instance = sandbox();
    const writer = initSummariesDb(instance);
    writer.close();

    const db = new DatabaseSync(instance.summariesDbPath, { readOnly: true });
    expect(() =>
      db.exec(`INSERT INTO conversation_summaries (conversation_id) VALUES ('${UUID_A}')`),
    ).toThrow();
    db.close();
  });
});

describe("listBrainArtifacts", () => {
  it("lists artifact files and excludes .system_generated", () => {
    const instance = sandbox();
    const brain = join(instance.brainDir, UUID_A);
    mkdirSync(join(brain, ".system_generated", "logs"), { recursive: true });
    writeFileSync(join(brain, ".system_generated", "logs", "transcript.jsonl"), "{}\n");
    writeFileSync(join(brain, "deps_fix_report.md"), "# report");
    writeFileSync(join(brain, "shot.png"), "png");

    const artifacts = listBrainArtifacts(instance.brainDir, UUID_A);
    expect(artifacts.map((artifact) => artifact.name).sort()).toEqual([
      "deps_fix_report.md",
      "shot.png",
    ]);
    const report = artifacts.find((artifact) => artifact.name === "deps_fix_report.md");
    expect(report?.bytes).toBe("# report".length);
    expect(report?.path).toBe(join(brain, "deps_fix_report.md"));
    expect(typeof report?.modifiedAt).toBe("string");
  });

  it("returns an empty array for unknown conversations", () => {
    const instance = sandbox();
    expect(listBrainArtifacts(instance.brainDir, UUID_B)).toEqual([]);
  });
});
