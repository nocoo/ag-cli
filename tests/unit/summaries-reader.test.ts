import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listBrainArtifacts, openSummariesReader } from "../../src/infra/summaries-reader";
import { createSandbox, initSummariesDb, type Sandbox } from "../helpers/sandbox";

const active: Sandbox[] = [];

function sandbox(): Sandbox {
  const created = createSandbox("nullg-unit-summaries");
  active.push(created);
  return created;
}

afterEach(() => {
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("openSummariesReader", () => {
  it("returns null when the database file is absent", () => {
    const instance = sandbox();
    expect(openSummariesReader(instance.summariesDbPath)).toBeNull();
  });

  it("maps sparse rows with null columns safely", () => {
    const instance = sandbox();
    const writer = initSummariesDb(instance);
    writer.prepare("INSERT INTO conversation_summaries (conversation_id) VALUES (?)").run(UUID_A);
    writer.close();

    const reader = openSummariesReader(instance.summariesDbPath);
    expect(reader).not.toBeNull();
    try {
      const row = reader?.getConversation(UUID_A);
      expect(row).toMatchObject({
        conversation_id: UUID_A,
        title: null,
        preview: null,
        step_count: 0,
        status: "CASCADE_RUN_STATUS_IDLE",
        not_fully_idle: 0,
        killed: 0,
        last_user_input_step_index: null,
      });
      expect(reader?.listConversations()).toHaveLength(1);
    } finally {
      reader?.close();
    }
  });

  it("maps fully populated rows faithfully", () => {
    const instance = sandbox();
    const writer = initSummariesDb(instance);
    writer
      .prepare(
        "INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id, parent_conversation_id, nesting_depth, not_fully_idle, killed, last_user_input_step_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        UUID_A,
        "full row",
        "preview text",
        42,
        "2026-11-14T03:00:00Z",
        JSON.stringify(["file:///tmp/repo"]),
        "CASCADE_RUN_STATUS_RUNNING",
        "e80ab9ca-b14a-4dc9-9c0c-e6a931f333e4",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        2,
        1,
        1,
        17,
      );
    writer.close();

    const reader = openSummariesReader(instance.summariesDbPath);
    expect(reader).not.toBeNull();
    try {
      expect(reader?.getConversation(UUID_A)).toEqual({
        conversation_id: UUID_A,
        title: "full row",
        preview: "preview text",
        step_count: 42,
        last_modified_time: "2026-11-14T03:00:00Z",
        workspace_uris: JSON.stringify(["file:///tmp/repo"]),
        status: "CASCADE_RUN_STATUS_RUNNING",
        project_id: "e80ab9ca-b14a-4dc9-9c0c-e6a931f333e4",
        parent_conversation_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        nesting_depth: 2,
        not_fully_idle: 1,
        killed: 1,
        last_user_input_step_index: 17,
      });
    } finally {
      reader?.close();
    }
  });
});

describe("listBrainArtifacts", () => {
  it("returns an empty array when the conversation brain dir is missing", () => {
    const instance = sandbox();
    expect(listBrainArtifacts(instance.brainDir, UUID_A)).toEqual([]);
  });

  it("ignores directories inside the conversation brain dir", () => {
    const instance = sandbox();
    const brain = join(instance.brainDir, UUID_A);
    mkdirSync(join(brain, "screens"), { recursive: true });
    writeFileSync(join(brain, "notes.md"), "notes");

    const artifacts = listBrainArtifacts(instance.brainDir, UUID_A);
    expect(artifacts.map((artifact) => artifact.name)).toEqual(["notes.md"]);
  });

  it("sorts artifacts by name regardless of creation order", () => {
    const instance = sandbox();
    const brain = join(instance.brainDir, UUID_A);
    mkdirSync(brain, { recursive: true });
    writeFileSync(join(brain, "zz-report.md"), "zz");
    writeFileSync(join(brain, "aa-report.md"), "aa");
    writeFileSync(join(brain, "mm-report.md"), "mm");

    expect(listBrainArtifacts(instance.brainDir, UUID_A).map((artifact) => artifact.name)).toEqual([
      "aa-report.md",
      "mm-report.md",
      "zz-report.md",
    ]);
  });
});
