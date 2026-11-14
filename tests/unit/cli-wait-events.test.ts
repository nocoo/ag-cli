import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliContext, runCli } from "../../src/cli/index";
import { resolvePaths } from "../../src/infra/paths";
import { StateStore } from "../../src/infra/state-store";
import {
  createSandbox,
  initSummariesDb,
  runAgentapi,
  type Sandbox,
  writeMockAgentapi,
} from "../helpers/sandbox";

const active: Sandbox[] = [];

function sandbox(): Sandbox {
  const created = createSandbox("ag-cli-unit-wait");
  active.push(created);
  return created;
}

function context(tty: boolean, env: Record<string, string> = {}): CliContext {
  const make = () => {
    const stream = {
      isTTY: tty,
      write(chunk: string) {
        stream.chunks.push(chunk);
        return true;
      },
      chunks: [] as string[],
    };
    return stream;
  };
  return { stdout: make(), stderr: make(), env: { ...env } };
}

function stdoutText(ctx: CliContext): string {
  return (ctx.stdout as unknown as { chunks: string[] }).chunks.join("");
}

function stderrText(ctx: CliContext): string {
  return (ctx.stderr as unknown as { chunks: string[] }).chunks.join("");
}

function stdoutJson<T>(ctx: CliContext): T {
  return JSON.parse(stdoutText(ctx)) as T;
}

function logsDir(instance: Sandbox, conversationId: string): string {
  return join(instance.brainDir, conversationId, ".system_generated", "logs");
}

afterEach(() => {
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

async function preparedWorker(instance: Sandbox, mode?: string): Promise<string> {
  initSummariesDb(instance);
  writeMockAgentapi(instance);
  const result = runAgentapi(instance, ["new-conversation", "--message", "seed"], {
    ...(mode === undefined ? {} : { AG_MOCK_AGENTAPI_MODE: mode }),
  });
  return (JSON.parse(result.stdout) as { conversationId: string }).conversationId;
}

function registerOwner(instance: Sandbox, ownerId: string): void {
  const db = initSummariesDb(instance);
  db.prepare(
    "INSERT INTO conversation_summaries (conversation_id, title) VALUES (?, ?)" +
      " ON CONFLICT(conversation_id) DO NOTHING",
  ).run(ownerId, "owner");
  db.close();
}

describe("wait command", () => {
  it("returns reason done for settled conversations", async () => {
    const instance = sandbox();
    const conversationId = await preparedWorker(instance);
    const store = StateStore.open(resolvePaths(instance.env).stateDbPath, { create: true });
    store.registerConversation(conversationId, { name: "worker" });
    store.close();

    const ctx = context(false, instance.env);
    const code = await runCli(["wait", "worker", "--json"], ctx);
    expect(code).toBe(0);
    expect(
      stdoutJson<{
        reason: string;
        target: { shortId: number; name: string; status: string; turn: number; stepCount: number };
        durationMs: number;
        latestReplyPreview: string;
      }>(ctx),
    ).toMatchObject({
      reason: "done",
      target: { shortId: "c1", name: "worker", status: "done", turn: 1, stepCount: 3 },
      latestReplyPreview: "Mock reply for: seed",
    });
    expect(typeof stdoutJson<{ durationMs: number }>(ctx).durationMs).toBe("number");
  });

  it("returns reason blocked for blocked conversations", async () => {
    const instance = sandbox();
    const conversationId = await preparedWorker(instance, "blocked");

    const ctx = context(false, instance.env);
    const code = await runCli(["wait", conversationId, "--json"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ reason: string }>(ctx).reason).toBe("blocked");
  });

  it("exits 124 with reason timeout on stuck conversations", async () => {
    const instance = sandbox();
    const conversationId = await preparedWorker(instance, "stuck");

    const ctx = context(false, instance.env);
    const code = await runCli(["wait", "--timeout", "1", conversationId, "--json"], ctx);
    expect(code).toBe(124);
    expect(stdoutJson<{ reason: string }>(ctx).reason).toBe("timeout");
  }, 10000);

  it("waits indefinitely with --timeout 0", async () => {
    const instance = sandbox();
    const conversationId = await preparedWorker(instance, "stuck");
    const ctx = context(false, instance.env);
    const waitPromise = runCli(["wait", "--timeout", "0", conversationId, "--json"], ctx);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const db = initSummariesDb(instance);
    db.prepare(
      "UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE', not_fully_idle = 0 WHERE conversation_id = ?",
    ).run(conversationId);
    db.close();
    appendFileSync(
      join(logsDir(instance, conversationId), "transcript.jsonl"),
      `${JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "late" })}\n`,
    );
    const code = await waitPromise;
    expect(code).toBe(0);
    expect(stdoutJson<{ reason: string }>(ctx).reason).toBe("done");
  }, 10000);

  it("propagates ambiguous owner prefixes for children waits", async () => {
    const instance = sandbox();
    await preparedWorker(instance);
    await preparedWorker(instance);
    const db = initSummariesDb(instance);
    db.prepare("INSERT INTO conversation_summaries (conversation_id, title) VALUES (?, ?)").run(
      "7a7a7a7a-1111-4111-8111-111111111111",
      "a1",
    );
    db.prepare("INSERT INTO conversation_summaries (conversation_id, title) VALUES (?, ?)").run(
      "7a7a7a7a-2222-4222-8222-222222222222",
      "a2",
    );
    db.close();

    const ctx = context(false, instance.env);
    const code = await runCli(["wait", "--children", "all", "7a7a7a7a", "--json"], ctx);
    expect(code).toBe(1);
    expect(stderrText(ctx)).toContain("ambiguous_target");
  });

  it("ignores terminated and killed children", async () => {
    const instance = sandbox();
    const parent = "7b7b7b7b-7b7b-47b7-87b7-7b7b7b7b7b7b";
    const dead = await preparedWorker(instance, "stuck");
    const killed = await preparedWorker(instance, "stuck");
    const store = StateStore.open(resolvePaths(instance.env).stateDbPath, { create: true });
    store.registerConversation(dead, { name: "dead-child", parentId: parent });
    store.markTerminated(dead);
    store.registerConversation(killed, { name: "killed-child", parentId: parent });
    store.close();
    const db = initSummariesDb(instance);
    db.prepare("UPDATE conversation_summaries SET killed = 1 WHERE conversation_id = ?").run(
      killed,
    );
    db.close();
    registerOwner(instance, parent);

    const ctx = context(false, { ...instance.env, AG_CLI_CALLER_ID: parent });
    const code = await runCli(["wait", "--children", "all", "--json", "--timeout", "3"], ctx);
    expect(code).toBe(0);
    const payload = stdoutJson<{ reason: string; children: Array<unknown> }>(ctx);
    expect(payload.reason).toBe("done");
    expect(payload.children).toEqual([]);
  }, 10000);

  it("maps idle children to done in all-mode results", async () => {
    const instance = sandbox();
    const parent = "7c7c7c7c-7c7c-47c7-87c7-7c7c7c7c7c7c";
    const child = "7d7d7d7d-7d7d-47d7-87d7-7d7d7d7d7d7d";
    const db = initSummariesDb(instance);
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, parent_conversation_id) VALUES (?, ?, ?)",
    ).run(child, "idle child", parent);
    db.close();
    registerOwner(instance, parent);

    const ctx = context(false, { ...instance.env, AG_CLI_CALLER_ID: parent });
    const code = await runCli(["wait", "--children", "all", "--json"], ctx);
    expect(code).toBe(0);
    const payload = stdoutJson<{ reason: string; target: { turn: number; stepCount: number } }>(
      ctx,
    );
    expect(payload.reason).toBe("done");
    expect(payload.target.turn).toBe(0);
    expect(payload.target.stepCount).toBe(0);
  });

  it("requires a target without a caller", async () => {
    const instance = sandbox();
    await preparedWorker(instance);
    const ctx = context(false, instance.env);
    expect(await runCli(["wait"], ctx)).toBe(2);
  });

  it("defaults to the caller conversation", async () => {
    const instance = sandbox();
    const conversationId = await preparedWorker(instance);
    const ctx = context(false, { ...instance.env, ANTIGRAVITY_CONVERSATION_ID: conversationId });
    const code = await runCli(["wait", "--json"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ target: { conversationId: string } }>(ctx).target.conversationId).toBe(
      conversationId,
    );
  });

  it("rejects invalid --children values and missing callers", async () => {
    const instance = sandbox();
    await preparedWorker(instance);

    const bad = context(false, instance.env);
    expect(await runCli(["wait", "--children", "some", "c1"], bad)).toBe(2);

    const noCaller = context(false, instance.env);
    const code = await runCli(["wait", "--children", "any"], noCaller);
    expect(code).toBe(2);
    expect(JSON.parse(stderrText(noCaller))).toMatchObject({ error: { kind: "invalid_usage" } });
  });

  it("waits for any child to settle", async () => {
    const instance = sandbox();
    const parent = "3f3f3f3f-3f3f-43f3-83f3-3f3f3f3f3f3f";
    const child = await preparedWorker(instance);
    const store = StateStore.open(resolvePaths(instance.env).stateDbPath, { create: true });
    store.registerConversation(child, { name: "child-a", parentId: parent });
    store.close();

    registerOwner(instance, parent);
    const ctx = context(false, { ...instance.env, AG_CLI_CALLER_ID: parent });
    const code = await runCli(["wait", "--children", "any", "--json"], ctx);
    expect(code).toBe(0);
    const payload = stdoutJson<{ reason: string; target: { conversationId: string } }>(ctx);
    expect(payload).toMatchObject({ reason: "done" });
    expect(payload.target.conversationId).toBe(child);
  });

  it("returns reason message when the caller receives an inbound message while waiting", async () => {
    const instance = sandbox();
    const parent = "4f4f4f4f-4f4f-44f4-84f4-4f4f4f4f4f4f";
    const stuckChild = await preparedWorker(instance, "stuck");
    const store = StateStore.open(resolvePaths(instance.env).stateDbPath, { create: true });
    store.registerConversation(stuckChild, { name: "stuck-child", parentId: parent });
    store.close();

    mkdirSync(join(instance.brainDir, parent, ".system_generated", "logs"), { recursive: true });
    const callerTranscript = join(
      instance.brainDir,
      parent,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    writeFileSync(
      callerTranscript,
      `${JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "first" })}\n`,
    );

    registerOwner(instance, parent);
    const ctx = context(false, { ...instance.env, AG_CLI_CALLER_ID: parent });
    const waitPromise = runCli(["wait", "--children", "any", "--json", "--timeout", "5"], ctx);
    await new Promise((resolve) => setTimeout(resolve, 300));
    appendFileSync(
      callerTranscript,
      `${JSON.stringify({ step_index: 1, type: "USER_INPUT", status: "DONE", content: "wake up" })}\n`,
    );
    const code = await waitPromise;
    expect(code).toBe(0);
    expect(stdoutJson<{ reason: string }>(ctx).reason).toBe("message");
  }, 10000);

  it("waits for all children to leave working", async () => {
    const instance = sandbox();
    const parent = "5f5f5f5f-5f5f-45f5-85f5-5f5f5f5f5f5f";
    const first = await preparedWorker(instance);
    const second = await preparedWorker(instance);
    const store = StateStore.open(resolvePaths(instance.env).stateDbPath, { create: true });
    store.registerConversation(first, { name: "child-a", parentId: parent });
    store.registerConversation(second, { name: "child-b", parentId: parent });
    store.close();

    registerOwner(instance, parent);
    const ctx = context(false, { ...instance.env, AG_CLI_CALLER_ID: parent });
    const code = await runCli(["wait", "--children", "all", "--json"], ctx);
    expect(code).toBe(0);
    const payload = stdoutJson<{
      reason: string;
      children: Array<{ conversationId: string; status: string }>;
    }>(ctx);
    expect(payload.reason).toBe("done");
    expect(payload.children).toHaveLength(2);
    expect(payload.children.every((child) => child.status === "done")).toBe(true);
  });

  it("resolves immediately when --children all finds no children", async () => {
    const instance = sandbox();
    const parent = "6f6f6f6f-6f6f-46f6-86f6-6f6f6f6f6f6f";
    registerOwner(instance, parent);
    const ctx = context(false, { ...instance.env, AG_CLI_CALLER_ID: parent });
    const code = await runCli(["wait", "--children", "all", "--json"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ reason: string; children: Array<unknown> }>(ctx)).toMatchObject({
      reason: "done",
      children: [],
    });
  });

  it("discovers children linked through summaries parent ids", async () => {
    const instance = sandbox();
    const parent = "9f9f9f9f-9f9f-49f9-89f9-9f9f9f9f9f9f";
    const child = await preparedWorker(instance);
    const db = initSummariesDb(instance);
    db.prepare(
      "UPDATE conversation_summaries SET parent_conversation_id = ? WHERE conversation_id = ?",
    ).run(parent, child);
    db.close();

    registerOwner(instance, parent);
    const ctx = context(false, { ...instance.env, AG_CLI_CALLER_ID: parent });
    const code = await runCli(["wait", "--children", "any", "--json"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ target: { conversationId: string } }>(ctx).target.conversationId).toBe(
      child,
    );
  });

  it("times out children waits with exit 124", async () => {
    const instance = sandbox();
    const parent = "afafafaf-afaf-4afa-8afa-afafafafafaf";
    const child = await preparedWorker(instance, "stuck");
    const store = StateStore.open(resolvePaths(instance.env).stateDbPath, { create: true });
    store.registerConversation(child, { name: "stuck-child", parentId: parent });
    store.close();

    registerOwner(instance, parent);
    const ctx = context(false, { ...instance.env, AG_CLI_CALLER_ID: parent });
    const code = await runCli(["wait", "--children", "any", "--timeout", "1", "--json"], ctx);
    expect(code).toBe(124);
    expect(stdoutJson<{ reason: string }>(ctx).reason).toBe("timeout");
  }, 10000);

  it("rejects invalid --timeout values", async () => {
    const instance = sandbox();
    await preparedWorker(instance);
    const ctx = context(false, instance.env);
    expect(await runCli(["wait", "--timeout", "x", "c404"], ctx)).toBe(2);
  });

  it("renders children waits on a tty", async () => {
    const instance = sandbox();
    const parent = "7e7e7e7e-7e7e-47e7-87e7-7e7e7e7e7e7e";
    const child = await preparedWorker(instance);
    const store = StateStore.open(resolvePaths(instance.env).stateDbPath, { create: true });
    store.registerConversation(child, { name: "tty-child", parentId: parent });
    store.close();
    registerOwner(instance, parent);

    const ctx = context(true, { ...instance.env, AG_CLI_CALLER_ID: parent });
    const code = await runCli(["wait", "--children", "any"], ctx);
    expect(code).toBe(0);
    const text = stdoutText(ctx);
    expect(text).toContain("c1 (tty-child)");
    expect(text).toContain("done");
  });

  it("renders a tty summary line", async () => {
    const instance = sandbox();
    const conversationId = await preparedWorker(instance);
    const ctx = context(true, instance.env);
    const code = await runCli(["wait", conversationId], ctx);
    expect(code).toBe(0);
    const text = stdoutText(ctx);
    expect(text).toContain("done");
    expect(text).toContain("Mock reply for: seed");
  });

  it("renders tty summaries for nameless conversations", async () => {
    const instance = sandbox();
    const conversationId = await preparedWorker(instance, "stuck");
    const ctx = context(true, instance.env);
    const code = await runCli(["wait", "--timeout", "1", conversationId], ctx);
    expect(code).toBe(124);
    expect(stdoutText(ctx)).toContain(conversationId.slice(0, 8));
    expect(stdoutText(ctx)).toContain("timeout");
  }, 10000);
});

describe("events command", () => {
  async function collectEvents(
    instance: Sandbox,
    args: string[],
    action: () => Promise<void>,
    tty = false,
  ): Promise<{ lines: string[]; codePromise: Promise<number> }> {
    const { runEventsCommand } = await import("../../src/cli/commands/events");
    const ctx = context(tty, instance.env);
    const controller = new AbortController();
    const codePromise = runEventsCommand(args, ctx, { abort: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await action();
    await new Promise((resolve) => setTimeout(resolve, 250));
    controller.abort();
    const code = await codePromise;
    expect(code).toBe(0);
    return {
      lines: (ctx.stdout as unknown as { chunks: string[] }).chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0),
      codePromise: Promise.resolve(code),
    };
  }

  it("streams step, turn, status and artifact events for a target", async () => {
    const instance = sandbox();
    const conversationId = await preparedWorker(instance, "stuck");
    const store = StateStore.open(resolvePaths(instance.env).stateDbPath, { create: true });
    store.registerConversation(conversationId, { name: "tracked" });
    store.close();

    const { lines } = await collectEvents(instance, ["--target", "tracked"], async () => {
      const transcript = join(logsDir(instance, conversationId), "transcript.jsonl");
      appendFileSync(
        transcript,
        `${JSON.stringify({ step_index: 3, type: "USER_INPUT", status: "DONE", content: "next" })}\n`,
      );
      appendFileSync(
        transcript,
        `${JSON.stringify({ step_index: 4, type: "PLANNER_RESPONSE", status: "DONE", content: "final" })}\n`,
      );
      const db = initSummariesDb(instance);
      db.prepare(
        "UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE', not_fully_idle = 0 WHERE conversation_id = ?",
      ).run(conversationId);
      db.close();
      writeFileSync(join(instance.brainDir, conversationId, "artifact.md"), "report");
    });

    const parsed = lines.map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          stepIndex?: number;
          turn?: number;
          status?: string;
          artifact?: { name: string };
          shortId?: string | null;
        },
    );
    expect(parsed).toContainEqual(
      expect.objectContaining({ type: "step", stepIndex: 3, shortId: "c1" }),
    );
    expect(parsed).toContainEqual(expect.objectContaining({ type: "turn", turn: 2 }));
    expect(parsed).toContainEqual(expect.objectContaining({ type: "status", status: "done" }));
    expect(parsed).toContainEqual(
      expect.objectContaining({
        type: "artifact",
        artifact: { name: "artifact.md", path: expect.any(String) },
      }),
    );
    expect(parsed.some((event) => event.type === "state" || event.type === "terminal")).toBe(false);
  });

  it("emits heartbeats on the injected interval", async () => {
    const instance = sandbox();
    const conversationId = await preparedWorker(instance);
    const { lines } = await collectEvents(
      instance,
      ["--target", conversationId, "--heartbeat-ms", "60"],
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
    );
    const parsed = lines.map((line) => JSON.parse(line) as { type: string });
    expect(parsed.filter((event) => event.type === "heartbeat").length).toBeGreaterThanOrEqual(2);
  });

  it("filters by label and children-of", async () => {
    const instance = sandbox();
    const parent = "7f7f7f7f-7f7f-47f7-87f7-7f7f7f7f7f7f";
    const labeled = await preparedWorker(instance);
    const unrelated = await preparedWorker(instance);
    registerOwner(instance, parent);
    const store = StateStore.open(resolvePaths(instance.env).stateDbPath, { create: true });
    store.registerConversation(labeled, { name: "labeled", parentId: parent });
    store.setLabels(labeled, ["env=prod"]);
    store.registerConversation(unrelated, { name: "unrelated" });
    store.close();

    const labelRun = await collectEvents(
      instance,
      ["--target", "labeled", "--label", "env=prod"],
      async () => {
        appendFileSync(
          join(logsDir(instance, labeled), "transcript.jsonl"),
          `${JSON.stringify({ step_index: 3, type: "GENERIC", status: "DONE" })}\n`,
        );
        appendFileSync(
          join(logsDir(instance, unrelated), "transcript.jsonl"),
          `${JSON.stringify({ step_index: 3, type: "GENERIC", status: "DONE" })}\n`,
        );
      },
    );
    const labelIds = new Set(
      labelRun.lines.map(
        (line) => (JSON.parse(line) as { conversationId?: string }).conversationId,
      ),
    );
    expect(labelIds.has(labeled)).toBe(true);
    expect(labelIds.has(unrelated)).toBe(false);

    const childrenRun = await collectEvents(instance, ["--children-of", parent], async () => {
      appendFileSync(
        join(logsDir(instance, labeled), "transcript.jsonl"),
        `${JSON.stringify({ step_index: 4, type: "GENERIC", status: "DONE" })}\n`,
      );
    });
    const childrenIds = new Set(
      childrenRun.lines.map(
        (line) => (JSON.parse(line) as { conversationId?: string }).conversationId,
      ),
    );
    expect(childrenIds.has(labeled)).toBe(true);
    expect(childrenIds.has(unrelated)).toBe(false);
  });

  it("skips unmanaged conversations when label filters are active", async () => {
    const instance = sandbox();
    const labeled = await preparedWorker(instance);
    await preparedWorker(instance);
    const store = StateStore.open(resolvePaths(instance.env).stateDbPath, { create: true });
    store.registerConversation(labeled, { name: "labeled" });
    store.setLabels(labeled, ["env=prod"]);
    store.close();

    const { lines } = await collectEvents(instance, ["--label", "env=prod"], async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const ids = new Set(
      lines.map((line) => (JSON.parse(line) as { conversationId?: string }).conversationId),
    );
    expect(ids.has(labeled)).toBe(false);
  });

  it("streams all active conversations by default", async () => {
    const instance = sandbox();
    const conversationId = await preparedWorker(instance);
    const { lines } = await collectEvents(instance, [], async () => {
      appendFileSync(
        join(logsDir(instance, conversationId), "transcript.jsonl"),
        `${JSON.stringify({ step_index: 3, type: "GENERIC", status: "DONE" })}\n`,
      );
    });
    const ids = new Set(
      lines.map((line) => (JSON.parse(line) as { conversationId?: string }).conversationId),
    );
    expect(ids.has(conversationId)).toBe(true);
  });

  it("renders human-readable lines on a tty", async () => {
    const instance = sandbox();
    const conversationId = await preparedWorker(instance, "stuck");
    const { lines } = await collectEvents(
      instance,
      ["--target", conversationId],
      async () => {
        appendFileSync(
          join(logsDir(instance, conversationId), "transcript.jsonl"),
          `${JSON.stringify({ step_index: 3, type: "USER_INPUT", status: "DONE" })}\n`,
        );
        appendFileSync(
          join(logsDir(instance, conversationId), "transcript.jsonl"),
          `${JSON.stringify({ step_index: 4, type: "PLANNER_RESPONSE", status: "DONE" })}\n`,
        );
        const db = initSummariesDb(instance);
        db.prepare(
          "UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE', not_fully_idle = 0 WHERE conversation_id = ?",
        ).run(conversationId);
        db.close();
      },
      true,
    );
    expect(lines.some((line) => line.includes("step") && line.includes("3"))).toBe(true);
    expect(lines.some((line) => line.includes("turn 2"))).toBe(true);
    expect(lines.some((line) => line.includes("status done"))).toBe(true);
    expect(lines.every((line) => line.startsWith("{"))).toBe(false);
  });

  it("renders tty heartbeats on the injected interval", async () => {
    const instance = sandbox();
    const conversationId = await preparedWorker(instance);
    const { lines } = await collectEvents(
      instance,
      ["--target", conversationId, "--heartbeat-ms", "60"],
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
      true,
    );
    expect(lines.some((line) => line.includes("heartbeat"))).toBe(true);
  });

  it("shuts down cleanly on process signals when no abort signal is given", async () => {
    const instance = sandbox();
    const conversationId = await preparedWorker(instance);
    const { runEventsCommand } = await import("../../src/cli/commands/events");
    const ctx = context(false, instance.env);
    const codePromise = runEventsCommand(["--target", conversationId, "--heartbeat-ms", "50"], ctx);
    await new Promise((resolve) => setTimeout(resolve, 150));
    process.emit("SIGTERM", "SIGTERM");
    expect(await codePromise).toBe(0);
  });

  it("falls back to the raw owner id for unresolvable --children-of values", async () => {
    const instance = sandbox();
    const parent = "hc:t42";
    const child = await preparedWorker(instance);
    const store = StateStore.open(resolvePaths(instance.env).stateDbPath, { create: true });
    store.registerConversation(child, { name: "hc-child", parentId: parent });
    store.close();
    const db = initSummariesDb(instance);
    db.prepare(
      "UPDATE conversation_summaries SET parent_conversation_id = ? WHERE conversation_id = ?",
    ).run(parent, child);
    db.close();

    const { lines } = await collectEvents(instance, ["--children-of", parent], async () => {
      appendFileSync(
        join(logsDir(instance, child), "transcript.jsonl"),
        `${JSON.stringify({ step_index: 3, type: "GENERIC", status: "DONE" })}\n`,
      );
    });
    const ids = new Set(
      lines.map((line) => (JSON.parse(line) as { conversationId?: string }).conversationId),
    );
    expect(ids.has(child)).toBe(true);
  });

  it("returns immediately for pre-aborted signals", async () => {
    const instance = sandbox();
    await preparedWorker(instance);
    const { runEventsCommand } = await import("../../src/cli/commands/events");
    const chunks: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const code = await runEventsCommand(
      ["--heartbeat-ms", "50"],
      {
        stdout: {
          isTTY: false,
          write(chunk: string) {
            chunks.push(chunk);
            return true;
          },
        },
        env: instance.env,
      },
      { abort: controller.signal },
    );
    expect(code).toBe(0);
    expect(chunks).toEqual([]);
  });

  it("announces conversations created after start", async () => {
    const instance = sandbox();
    await preparedWorker(instance);
    const { runEventsCommand } = await import("../../src/cli/commands/events");
    const chunks: string[] = [];
    const controller = new AbortController();
    const codePromise = runEventsCommand(
      ["--heartbeat-ms", "5000", "--discovery-ms", "60", "--json"],
      {
        stdout: {
          isTTY: false,
          write(chunk: string) {
            chunks.push(chunk);
            return true;
          },
        },
        env: instance.env,
      },
      { abort: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    const created = runAgentapi(instance, ["new-conversation", "--message", "fresh"]);
    const freshId = (JSON.parse(created.stdout) as { conversationId: string }).conversationId;
    await new Promise((resolve) => setTimeout(resolve, 400));
    controller.abort();
    expect(await codePromise).toBe(0);
    const events = chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; conversationId?: string });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "created", conversationId: freshId }),
    );
  });

  it("rejects invalid label filters and heartbeat values", async () => {
    const instance = sandbox();
    await preparedWorker(instance);
    const ctx = context(false, instance.env);
    const code = await runCli(["events", "--label", "broken"], ctx);
    expect(code).toBe(2);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({ error: { kind: "invalid_usage" } });

    const badHeartbeat = context(false, instance.env);
    expect(await runCli(["events", "--heartbeat-ms", "x", "--target", "c404"], badHeartbeat)).toBe(
      2,
    );
  });
});
