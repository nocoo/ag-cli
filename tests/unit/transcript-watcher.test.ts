import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptWatcher, type WatchChangeSource } from "../../src/infra/transcript-watcher";
import { createSandbox, initSummariesDb, type Sandbox } from "../helpers/sandbox";

const active: Sandbox[] = [];

function sandbox(): Sandbox {
  const created = createSandbox("ag-cli-unit-watcher");
  active.push(created);
  return created;
}

afterEach(() => {
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

const CONVERSATION = "11111111-1111-4111-8111-111111111111";

function logsDir(instance: Sandbox, conversationId = CONVERSATION): string {
  return join(instance.brainDir, conversationId, ".system_generated", "logs");
}

function transcriptPath(instance: Sandbox, conversationId = CONVERSATION): string {
  return join(logsDir(instance, conversationId), "transcript.jsonl");
}

function step(index: number, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ step_index: index, type: "GENERIC", status: "DONE", ...extra })}\n`;
}

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitFor condition not met"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe("incremental byteOffset reading", () => {
  it("returns only newly appended steps across reads", () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), step(0) + step(1));
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });

    expect(watcher.readNewSteps().map((entry) => entry.step_index)).toEqual([0, 1]);
    appendFileSync(transcriptPath(instance), step(2));
    expect(watcher.readNewSteps().map((entry) => entry.step_index)).toEqual([2]);
    expect(watcher.readNewSteps()).toEqual([]);
    watcher.close();
  });

  it("buffers partial trailing lines until the newline arrives", () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), step(0));
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });
    watcher.readNewSteps();

    appendFileSync(transcriptPath(instance), '{"step_index":1,"type":"GEN');
    expect(watcher.readNewSteps()).toEqual([]);
    appendFileSync(transcriptPath(instance), 'ERIC","status":"DONE"}\n');
    expect(watcher.readNewSteps().map((entry) => entry.step_index)).toEqual([1]);
    watcher.close();
  });

  it("skips malformed lines and re-reads from scratch when the file shrinks", () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), `${step(0)}{ broken\n${step(1)}${step(2)}`);
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });
    expect(watcher.readNewSteps().map((entry) => entry.step_index)).toEqual([0, 1, 2]);

    writeFileSync(transcriptPath(instance), step(5));
    expect(watcher.readNewSteps().map((entry) => entry.step_index)).toEqual([5]);
    watcher.close();
  });

  it("returns empty for missing transcripts and resets offsets", () => {
    const instance = sandbox();
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });
    expect(watcher.readNewSteps()).toEqual([]);

    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), step(0));
    expect(watcher.readNewSteps().map((entry) => entry.step_index)).toEqual([0]);
    watcher.close();
  });

  it("tracks transcript_full.jsonl increments independently", () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    const full = join(logsDir(instance), "transcript_full.jsonl");
    writeFileSync(transcriptPath(instance), step(0));
    writeFileSync(
      full,
      `${JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", content: "complete body" })}\n`,
    );
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });
    watcher.readNewSteps();
    const fullSteps = watcher.readNewFullSteps();
    expect(fullSteps).toHaveLength(1);
    expect(fullSteps[0]).toMatchObject({ content: "complete body" });
    expect(watcher.readNewFullSteps()).toEqual([]);
    watcher.close();
  });
});

describe("fs.watch wiring", () => {
  it("debounces rapid change notifications into one callback", async () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), "");
    let calls = 0;
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      debounceMs: 200,
      fallbackMs: 10_000,
      onChange: () => {
        calls += 1;
      },
    });
    watcher.start();
    appendFileSync(transcriptPath(instance), step(0));
    await new Promise((resolve) => setTimeout(resolve, 5));
    appendFileSync(transcriptPath(instance), step(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    appendFileSync(transcriptPath(instance), step(2));
    await waitFor(() => calls >= 1, 4000);
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(calls).toBe(1);
    watcher.close();
  });

  it("watches the parent brain dir while the logs dir does not exist yet", async () => {
    const instance = sandbox();
    mkdirSync(join(instance.brainDir, CONVERSATION), { recursive: true });
    let fired = false;
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      debounceMs: 10,
      fallbackMs: 60,
      onChange: () => {
        fired = true;
      },
    });
    watcher.start();
    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), step(0));
    await waitFor(() => fired, 5000);
    watcher.close();
  });

  it("falls back to the brain root when the conversation dir is missing", async () => {
    const instance = sandbox();
    let fired = false;
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      debounceMs: 10,
      fallbackMs: 60,
      onChange: () => {
        fired = true;
      },
    });
    watcher.start();
    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), step(0));
    await waitFor(() => fired, 5000);
    watcher.close();
  });
});

describe("fallback stat and data_version checks", () => {
  it("detects transcript changes through the fallback timer when watchers are silent", async () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), "");
    const sources: WatchChangeSource[] = [];
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      debounceMs: 10_000,
      fallbackMs: 50,
      onChange: (source) => {
        sources.push(source);
      },
    });
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 70));
    appendFileSync(transcriptPath(instance), step(0));
    await waitFor(() => sources.includes("transcript"));
    watcher.close();
  });

  it("detects summaries data_version bumps through the fallback timer", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    const sources: WatchChangeSource[] = [];
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      summariesDbPath: instance.summariesDbPath,
      debounceMs: 10_000,
      fallbackMs: 40,
      onChange: (source) => {
        sources.push(source);
      },
    });
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const db = initSummariesDb(instance);
    db.prepare("INSERT INTO conversation_summaries (conversation_id) VALUES (?)").run(CONVERSATION);
    db.close();
    await waitFor(() => sources.includes("summaries"));
    watcher.close();
  });

  it("ignores unreadable summaries databases", async () => {
    const instance = sandbox();
    const { writeFileSync: write } = await import("node:fs");
    write(join(instance.antigravityDir, "conversation_summaries.db"), "definitely not sqlite");
    const sources: WatchChangeSource[] = [];
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      summariesDbPath: instance.summariesDbPath,
      debounceMs: 10_000,
      fallbackMs: 30,
      onChange: (source) => {
        sources.push(source);
      },
    });
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sources).toEqual([]);
    watcher.close();
  });

  it("starting after close is a no-op", () => {
    const instance = sandbox();
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });
    watcher.close();
    watcher.start();
    expect(watcher.readNewSteps()).toEqual([]);
  });

  it("tolerates a missing summaries database", async () => {
    const instance = sandbox();
    const sources: WatchChangeSource[] = [];
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      summariesDbPath: join(instance.antigravityDir, "missing.db"),
      debounceMs: 10_000,
      fallbackMs: 30,
      onChange: (source) => {
        sources.push(source);
      },
    });
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sources).toEqual([]);
    watcher.close();
  });
});

describe("close", () => {
  it("stops emitting events and is idempotent", async () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), "");
    let calls = 0;
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      debounceMs: 10,
      fallbackMs: 30,
      onChange: () => {
        calls += 1;
      },
    });
    watcher.start();
    watcher.close();
    watcher.close();

    appendFileSync(transcriptPath(instance), step(0));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(calls).toBe(0);
  });
});
