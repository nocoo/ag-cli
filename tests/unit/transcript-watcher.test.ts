import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/infra/state-store";
import { TranscriptWatcher, type WatchChangeSource } from "../../src/infra/transcript-watcher";
import { createSandbox, initSummariesDb, type Sandbox } from "../helpers/sandbox";

const readSyncMeter = vi.hoisted(() => ({ bytes: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      const read = actual.readSync(...args);
      readSyncMeter.bytes += read;
      return read;
    },
  };
});

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
      fallbackMs: 2000,
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
    await waitFor(() => calls >= 1, 8000);
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(calls).toBeLessThanOrEqual(2);
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

describe("state database notifications", () => {
  it("reports state db changes through the fallback timer", async () => {
    const instance = sandbox();
    const { join: joinPath } = await import("node:path");
    const { writeFileSync: write } = await import("node:fs");
    const stateDbPath = joinPath(instance.agCliHome, "state.db");
    write(stateDbPath, "seed");
    const sources: WatchChangeSource[] = [];
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      stateDbPath,
      debounceMs: 10_000,
      fallbackMs: 40,
      onChange: (source) => {
        sources.push(source);
      },
    });
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    write(stateDbPath, "changed content");
    await waitFor(() => sources.includes("state"));
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

  it("never reopens summaries probes or watchers after close inside onChange (review F6)", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), step(0));
    let watcher: TranscriptWatcher | undefined;
    watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      summariesDbPath: instance.summariesDbPath,
      debounceMs: 5,
      fallbackMs: 20,
      onChange: () => {
        watcher?.close();
      },
    });
    watcher.start();
    appendFileSync(transcriptPath(instance), step(1));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((watcher as unknown as { closed: boolean }).closed).toBe(true);
    expect((watcher as unknown as { summariesProbe: unknown }).summariesProbe).toBeNull();
    const watchersAfter = (watcher as unknown as { watchers: unknown[] }).watchers.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((watcher as unknown as { watchers: unknown[] }).watchers.length).toBe(watchersAfter);
    expect((watcher as unknown as { summariesProbe: unknown }).summariesProbe).toBeNull();
  });

  it("fallbackCheck stops at the first onChange that closes the watcher (review F6)", () => {
    const instance = sandbox();
    const db = initSummariesDb(instance);
    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), step(0));
    let calls = 0;
    const watcher: TranscriptWatcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      summariesDbPath: instance.summariesDbPath,
      onChange: () => {
        calls += 1;
        watcher.close();
      },
    });
    const internals = watcher as unknown as {
      lastTranscriptStat: { size: number; mtimeMs: number };
      lastDataVersion: number | null;
      fallbackCheck(): void;
      attachLateLogsDir(): void;
      readDataVersion(): number | null;
      closed: boolean;
    };
    const stats = statSync(transcriptPath(instance));
    internals.lastTranscriptStat = { size: stats.size, mtimeMs: stats.mtimeMs };
    internals.lastDataVersion = 1;
    db.exec(
      "INSERT INTO conversation_summaries (conversation_id) VALUES ('33333333-3333-4333-8333-333333333333')",
    );
    internals.fallbackCheck();
    expect(internals.closed).toBe(true);
    expect(calls).toBe(1);
    internals.fallbackCheck();
    internals.attachLateLogsDir();
    expect(internals.readDataVersion()).toBeNull();
    expect(calls).toBe(1);
    db.close();
  });

  it("fallbackCheck stops when a transcript or state change closes the watcher (review F6)", () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), step(0));
    const stateDb = join(instance.agCliHome, "state.db");
    mkdirSync(instance.agCliHome, { recursive: true });
    writeFileSync(stateDb, "x");

    let transcriptCalls = 0;
    const transcriptWatcher: TranscriptWatcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {
        transcriptCalls += 1;
        transcriptWatcher.close();
      },
    });
    const transcriptInternals = transcriptWatcher as unknown as {
      lastTranscriptStat: { size: number; mtimeMs: number };
      fallbackCheck(): void;
      closed: boolean;
    };
    transcriptInternals.lastTranscriptStat = { size: -1, mtimeMs: -1 };
    transcriptInternals.fallbackCheck();
    expect(transcriptInternals.closed).toBe(true);
    expect(transcriptCalls).toBe(1);

    let stateCalls = 0;
    const stateWatcher: TranscriptWatcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      stateDbPath: stateDb,
      onChange: () => {
        stateCalls += 1;
        stateWatcher.close();
      },
    });
    const stateInternals = stateWatcher as unknown as {
      lastTranscriptStat: { size: number; mtimeMs: number };
      lastStateMtime: number | null;
      lastDataVersion: number | null;
      fallbackCheck(): void;
      closed: boolean;
    };
    const transcriptStats = statSync(transcriptPath(instance));
    stateInternals.lastTranscriptStat = {
      size: transcriptStats.size,
      mtimeMs: transcriptStats.mtimeMs,
    };
    stateInternals.lastDataVersion = null;
    stateInternals.lastStateMtime = -1;
    stateInternals.fallbackCheck();
    expect(stateInternals.closed).toBe(true);
    expect(stateCalls).toBe(1);
  });

  it("priming without a summaries db and debounce after close are no-ops (review F6)", async () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), step(0));
    let calls = 0;
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      debounceMs: 5,
      fallbackMs: 10_000,
      onChange: () => {
        calls += 1;
      },
    });
    watcher.start();
    watcher.close();
    (watcher as unknown as { schedule: () => void }).schedule();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(0);
  });
});

describe("in-place rewrite detection (review F12)", () => {
  it("resets the cursor and cache when the file is rewritten in place with equal size", () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    const path = transcriptPath(instance);
    writeFileSync(path, step(0, { content: "A" }));
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });
    watcher.readNewSteps();
    expect(watcher.currentSteps()).toHaveLength(1);

    writeFileSync(path, step(0, { content: "B" }));
    const fresh = watcher.readNewSteps();
    expect(fresh.map((entry) => entry.content)).toEqual(["B"]);
    expect(watcher.currentSteps().map((entry) => entry.content)).toEqual(["B"]);
    watcher.close();
  });

  it("resets the cursor and cache when a longer in-place rewrite replaces old content", () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    const path = transcriptPath(instance);
    writeFileSync(path, step(0, { content: "A" }));
    writeFileSync(path, step(0, { content: "short" }) + step(1, { content: "also short" }));
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });
    watcher.readNewSteps();
    expect(watcher.currentSteps()).toHaveLength(2);

    writeFileSync(
      path,
      step(0, { content: "a much longer rewritten line that changes every offset" }),
    );
    const fresh = watcher.readNewSteps();
    expect(fresh).toHaveLength(1);
    expect(watcher.currentSteps()).toHaveLength(1);
    expect(watcher.currentSteps()[0]?.content).toBe(
      "a much longer rewritten line that changes every offset",
    );
    watcher.close();
  });

  it("keeps the cache when only new bytes are appended", () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    const path = transcriptPath(instance);
    writeFileSync(path, step(0, { content: "A" }));
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });
    watcher.readNewSteps();
    appendFileSync(path, step(1, { content: "appended" }));
    watcher.readNewSteps();
    expect(watcher.currentSteps().map((entry) => entry.step_index)).toEqual([0, 1]);
    watcher.close();
  });

  it("increments a generation counter on every rewrite and reset", () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    const path = transcriptPath(instance);
    writeFileSync(path, step(0, { content: "A" }));
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });
    expect(watcher.generation).toBe(0);
    watcher.readNewSteps();
    expect(watcher.generation).toBe(0);
    writeFileSync(path, step(0, { content: "B" }));
    watcher.readNewSteps();
    expect(watcher.generation).toBe(1);
    writeFileSync(path, step(0, { content: "a much longer rewrite" }) + step(1));
    watcher.readNewSteps();
    expect(watcher.generation).toBe(2);
    expect(watcher.currentSteps().map((entry) => entry.step_index)).toEqual([0, 1]);
    watcher.close();
  });

  it("reads zero bytes when the transcript stat is unchanged and only new bytes on append (review R3 F13)", () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    const path = transcriptPath(instance);
    writeFileSync(path, step(0, { content: "x".repeat(64 * 1024) }));
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });
    watcher.readNewSteps();

    readSyncMeter.bytes = 0;
    expect(watcher.readNewSteps()).toEqual([]);
    expect(readSyncMeter.bytes).toBe(0);

    const extra = step(1);
    appendFileSync(path, extra);
    const fresh = watcher.readNewSteps();
    expect(fresh).toHaveLength(1);
    expect(readSyncMeter.bytes).toBe(extra.length);
    watcher.close();
  });

  it("notices state.db WAL commits through the fallback timer (review R3 F7)", async () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    writeFileSync(transcriptPath(instance), step(0));
    const statePath = join(instance.agCliHome, "state.db");
    mkdirSync(instance.agCliHome, { recursive: true });
    const writer = StateStore.open(statePath, { create: true });
    writer.registerConversation(CONVERSATION, {});
    const sources: string[] = [];
    const watcher: TranscriptWatcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      stateDbPath: statePath,
      debounceMs: 60_000,
      fallbackMs: 40,
      onChange: (source) => {
        sources.push(source);
      },
    });
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    writer.markTerminated(CONVERSATION);
    await waitFor(() => sources.includes("state"), 2000);
    watcher.close();
    const internals = watcher as unknown as { readStateDataVersion(): number | null };
    expect(internals.readStateDataVersion()).toBeNull();
    writer.close();

    const noState = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });
    expect(
      (noState as unknown as { readStateDataVersion(): number | null }).readStateDataVersion(),
    ).toBeNull();
    noState.close();
  });

  it("falls back to the verified rebuild when the fast append slice is malformed (review R3 F13)", () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    const path = transcriptPath(instance);
    writeFileSync(path, step(0, { content: "x".repeat(64 * 1024) }));
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });
    watcher.readNewSteps();
    expect(watcher.currentSteps()).toHaveLength(1);

    appendFileSync(path, `{ broken json\n${step(1, { content: "after garbage" })}`);
    const fresh = watcher.readNewSteps();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.step_index).toBe(1);
    expect(watcher.currentSteps()).toHaveLength(2);
    watcher.close();
  });

  it("buffers partial appends without emitting steps on the fast path", () => {
    const instance = sandbox();
    mkdirSync(logsDir(instance), { recursive: true });
    const path = transcriptPath(instance);
    writeFileSync(path, step(0, { content: "x".repeat(64 * 1024) }));
    const watcher = new TranscriptWatcher({
      antigravityDir: instance.antigravityDir,
      conversationId: CONVERSATION,
      onChange: () => {},
    });
    watcher.readNewSteps();
    appendFileSync(path, '{"step_index":1,"type":"GEN');
    expect(watcher.readNewSteps()).toEqual([]);
    appendFileSync(path, '","status":"DONE"}\n');
    const fresh = watcher.readNewSteps();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.step_index).toBe(1);
    watcher.close();
  });
});
