import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { awaitSettledStatus } from "../../src/cli/commands/await-settled";
import { resolvePaths } from "../../src/infra/paths";
import { StateStore } from "../../src/infra/state-store";
import { openSummariesReader } from "../../src/infra/summaries-reader";
import { TranscriptWatcher } from "../../src/infra/transcript-watcher";
import {
  createSandbox,
  initSummariesDb,
  runAgentapi,
  type Sandbox,
  writeMockAgentapi,
} from "../helpers/sandbox";

const active: Sandbox[] = [];

function sandbox(): Sandbox {
  const created = createSandbox("ag-cli-int-watcher");
  active.push(created);
  return created;
}

afterEach(() => {
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

describe("TranscriptWatcher against the mock agentapi", () => {
  it("streams incremental steps as the mock appends them", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const created = runAgentapi(instance, ["new-conversation", "first"]);
    const conversationId = (JSON.parse(created.stdout) as { conversationId: string })
      .conversationId;

    const received: number[] = [];
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId,
      debounceMs: 10,
      fallbackMs: 2000,
      onChange: () => {
        for (const step of watcher.readNewSteps()) {
          received.push(step.step_index ?? -1);
        }
      },
    });
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const sent = runAgentapi(instance, ["send-message", conversationId, "second"]);
    expect(sent.status).toBe(0);

    const expected = [3, 4, 5];
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = (): void => {
        if (expected.every((index) => received.includes(index))) {
          resolve();
          return;
        }
        if (Date.now() - started > 3000) {
          reject(new Error(`expected steps ${expected}, got ${received}`));
          return;
        }
        setTimeout(poll, 20);
      };
      poll();
    });
    watcher.close();
  });
});

describe("summaries-only and encoding edge cases", () => {
  it("resolves promptly on summaries-only changes through the wal directory watch", async () => {
    const instance = sandbox();
    const db = initSummariesDb(instance);
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, status, not_fully_idle) VALUES (?, 'CASCADE_RUN_STATUS_RUNNING', 1)",
    ).run("c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1");
    db.close();
    const logs = join(
      instance.brainDir,
      "c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1",
      ".system_generated",
      "logs",
    );
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "transcript.jsonl"),
      `${JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE" })}\n${JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "ok" })}\n`,
    );

    const paths = resolvePaths(instance.env);
    const reader = openSummariesReader(instance.summariesDbPath);
    const waitPromise = awaitSettledStatus({
      paths,
      reader,
      store: null,
      conversationId: "c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1",
      timeoutSec: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const db2 = initSummariesDb(instance);
    db2
      .prepare(
        "UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE', not_fully_idle = 0",
      )
      .run();
    db2.close();

    const started = Date.now();
    const outcome = await waitPromise;
    expect(outcome.status).toBe("done");
    expect(Date.now() - started).toBeLessThan(1500);
    reader?.close();
  }, 10000);

  it("never corrupts split multi-byte utf-8 sequences", () => {
    const instance = sandbox();
    const conversationId = "c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2";
    const logs = join(instance.brainDir, conversationId, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const path = join(logs, "transcript.jsonl");
    writeFileSync(path, "");
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId,
      onChange: () => {},
    });
    const payload = Buffer.from(
      `${JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "中文" })}\n`,
      "utf8",
    );
    const split = payload.length - 4;
    appendFileSync(path, payload.subarray(0, split));
    expect(watcher.readNewSteps()).toEqual([]);
    appendFileSync(path, payload.subarray(split));
    const steps = watcher.readNewSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0]?.content).toBe("中文");
    watcher.close();
  });

  it("detects same-size rewrites", () => {
    const instance = sandbox();
    const conversationId = "c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3";
    const logs = join(instance.brainDir, conversationId, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const path = join(logs, "transcript.jsonl");
    const first = `${JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "A" })}\n`;
    const second = `${JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "B" })}\n`;
    expect(first.length).toBe(second.length);
    writeFileSync(path, first);
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId,
      onChange: () => {},
    });
    expect(watcher.readNewSteps()).toHaveLength(1);
    writeFileSync(path, second);
    const rewritten = watcher.readNewSteps();
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]?.content).toBe("B");
    watcher.close();
  });
});

describe("turn watermark anti-race through awaitSettledStatus", () => {
  it("keeps waiting past a stale DONE planner until the watermark is reached", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const created = runAgentapi(instance, ["new-conversation", "first turn"]);
    const conversationId = (JSON.parse(created.stdout) as { conversationId: string })
      .conversationId;

    const paths = resolvePaths(instance.env);
    const store = StateStore.open(paths.stateDbPath, { create: true });
    store.registerConversation(conversationId, { name: "racy" });
    store.beginDelivery(conversationId, 3);

    const reader = openSummariesReader(instance.summariesDbPath);
    const stale = await awaitSettledStatus({
      paths,
      reader,
      store,
      conversationId,
      timeoutSec: 1,
    });
    expect(stale.timedOut).toBe(true);
    expect(stale.status).toBe("working");
    reader?.close();

    const logs = join(instance.brainDir, conversationId, ".system_generated", "logs");
    appendFileSync(
      join(logs, "transcript.jsonl"),
      `${JSON.stringify({ step_index: 3, type: "USER_INPUT", status: "DONE", content: "task" })}\n`,
    );
    const db = initSummariesDb(instance);
    db.prepare(
      "UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE', not_fully_idle = 0 WHERE conversation_id = ?",
    ).run(conversationId);
    db.close();
    appendFileSync(
      join(logs, "transcript.jsonl"),
      `${JSON.stringify({ step_index: 4, type: "PLANNER_RESPONSE", status: "DONE", content: "reply" })}\n`,
    );

    const reader2 = openSummariesReader(instance.summariesDbPath);
    const settled = await awaitSettledStatus({
      paths,
      reader: reader2,
      store,
      conversationId,
      timeoutSec: 2,
    });
    reader2?.close();
    store.close();
    expect(settled.timedOut).toBe(false);
    expect(settled.status).toBe("done");
  });

  it("settles blocked conversations through watcher events without polling loops", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const created = runAgentapi(instance, ["new-conversation", "needs approval"], {
      AG_MOCK_AGENTAPI_MODE: "blocked",
    });
    const conversationId = (JSON.parse(created.stdout) as { conversationId: string })
      .conversationId;
    const paths = resolvePaths(instance.env);

    const reader = openSummariesReader(instance.summariesDbPath);
    const outcome = await awaitSettledStatus({
      paths,
      reader,
      store: null,
      conversationId,
      timeoutSec: 3,
    });
    reader?.close();
    expect(outcome.status).toBe("blocked");
    expect(outcome.timedOut).toBe(false);
  });
});
