import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliContext, runCli } from "../../src/cli/index";
import { StateStore } from "../../src/infra/state-store";
import {
  createSandbox,
  initSummariesDb,
  type MockLanguageServer,
  readMockAgentapiCalls,
  readTranscript,
  runAgentapi,
  type Sandbox,
  startMockLanguageServer,
  writeHubFile,
  writeMockAgentapi,
} from "../helpers/sandbox";

const active: Sandbox[] = [];
const servers: MockLanguageServer[] = [];

function sandbox(): Sandbox {
  const created = createSandbox("ag-cli-unit-control");
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

async function prepared(
  responses: Record<string, unknown> = {},
  statusCodes: Record<string, number> = {},
): Promise<{ instance: Sandbox; server: MockLanguageServer }> {
  const instance = sandbox();
  initSummariesDb(instance);
  writeMockAgentapi(instance);
  const server = await startMockLanguageServer({ responses, statusCodes });
  servers.push(server);
  writeHubFile(instance, {
    pid: process.pid,
    httpPort: server.port,
    httpsPort: server.port,
    lsVersion: "1.0.0",
    csrfToken: server.csrfToken,
  });
  return { instance, server };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

describe("run command", () => {
  it("dispatches a new conversation with --bg and registers it in state.db", async () => {
    const { instance } = await prepared();
    const ctx = context(false, instance.env);
    const code = await runCli(
      [
        "run",
        "--bg",
        "--json",
        "--name",
        "deps-clip",
        "--label",
        "task=deps",
        "--label",
        "repo=clip",
        "upgrade deps",
      ],
      ctx,
    );
    expect(code).toBe(0);
    const payload = stdoutJson<{
      shortId: string;
      conversationId: string;
      name: string;
      title: string;
      reused: boolean;
      model: string;
      cwd: string;
      watermarkStep: number;
    }>(ctx);
    expect(payload).toMatchObject({
      shortId: "c1",
      name: "deps-clip",
      title: "deps-clip",
      reused: false,
      model: "flash",
      watermarkStep: 0,
    });
    expect(payload.conversationId).toHaveLength(36);

    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.findActiveByName("deps-clip")).toMatchObject({
      conversationId: payload.conversationId,
      shortId: 1,
      cwd: process.cwd(),
    });
    expect(store?.listLabels(payload.conversationId)).toEqual([
      { key: "repo", value: "clip" },
      { key: "task", value: "deps" },
    ]);
    store?.close();
    expect(readTranscript(instance, payload.conversationId)).toHaveLength(3);
  });

  it("injects the collaboration envelope for antigravity callers", async () => {
    const { instance } = await prepared();
    const first = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "orch", "first task"], first);
    const parentId = stdoutJson<{ conversationId: string }>(first).conversationId;

    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.releaseName(parentId);
    store.close();

    const second = context(false, { ...instance.env, ANTIGRAVITY_CONVERSATION_ID: parentId });
    await runCli(["run", "--bg", "--json", "child task"], second);
    const childId = stdoutJson<{ conversationId: string; parentId: string | null }>(
      second,
    ).conversationId;
    expect(stdoutJson<{ parentId: string | null }>(second).parentId).toBe(parentId);

    const steps = readTranscript(instance, childId);
    const inbound = String(steps[0]?.content ?? "");
    expect(inbound).toContain('<ag-cli from="c1 ');
    expect(inbound).toContain(
      `reach="ag-cli send ${parentId} \\"<summary or artifact path>\\" when done or blocked"`,
    );
    expect(inbound).toContain("child task");
    expect(inbound.endsWith("</ag-cli>")).toBe(true);
  });

  it("skips the envelope with --no-notify and honors hc callers", async () => {
    const { instance } = await prepared();
    const plain = context(false, { ...instance.env, HC_TERMINAL_ID: "t7" });
    await runCli(["run", "--bg", "--json", "--no-notify", "quiet task"], plain);
    const quietId = stdoutJson<{ conversationId: string }>(plain).conversationId;
    const quiet = String(readTranscript(instance, quietId)[0]?.content);
    expect(quiet).toContain("<ag-cli cwd=");
    expect(quiet).toContain("quiet task");
    expect(quiet).not.toContain("reach=");

    const wrapped = context(false, { ...instance.env, HC_TERMINAL_ID: "t9" });
    await runCli(["run", "--bg", "--json", "loud task"], wrapped);
    const loudId = stdoutJson<{ conversationId: string }>(wrapped).conversationId;
    const content = String(readTranscript(instance, loudId)[0]?.content ?? "");
    expect(content).toContain('<ag-cli from="hc:t9"');
    expect(content).toContain('reach="hc send t9');
  });

  it("resolves the project for --cwd and stores it", async () => {
    const { instance } = await prepared({
      ListProjects: { projects: [{ projectId: "proj-42", folderUri: `file:///tmp/widget` }] },
    });
    const ctx = context(false, instance.env);
    await runCli(
      ["run", "--bg", "--json", "--name", "widget", "--cwd", "/tmp/widget", "build it"],
      ctx,
    );
    const payload = stdoutJson<{ projectId: string | null; cwd: string }>(ctx);
    expect(payload).toMatchObject({ projectId: "proj-42", cwd: "/tmp/widget" });
  });

  it("passes model and project id into the real dispatch argv and env (review F1)", async () => {
    const cwd = join("/tmp", "r2 project");
    const { instance } = await prepared({
      ListProjects: {
        projects: [{ projectId: "wanted-project", folderUri: `file://${encodeURI(cwd)}` }],
      },
    });
    const ctx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--model", "pro", "--cwd", cwd, "build it"], ctx);
    expect(stdoutJson<{ model: string }>(ctx).model).toBe("pro");
    const call = readMockAgentapiCalls(instance).at(-1);
    expect(call?.args).toEqual(expect.arrayContaining(["--model", "pro"]));
    expect(call?.project).toBe("wanted-project");

    const reuse = context(false, instance.env);
    const runCtx2 = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "f1", "first"], runCtx2);
    const conversationId = stdoutJson<{ conversationId: string }>(runCtx2).conversationId;
    await runCli(
      [
        "run",
        "--bg",
        "--json",
        "--reuse",
        "--name",
        "f1",
        "--model",
        "pro",
        "--cwd",
        cwd,
        "second",
      ],
      reuse,
    );
    const reuseCall = readMockAgentapiCalls(instance).at(-1);
    expect(reuseCall?.project).toBe("wanted-project");
    expect(conversationId).toBeDefined();
  });

  it("reuses an active conversation with --reuse and advances the watermark", async () => {
    const { instance } = await prepared();
    const first = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "worker", "first"], first);
    const conversationId = stdoutJson<{ conversationId: string }>(first).conversationId;

    const second = context(false, instance.env);
    const code = await runCli(
      ["run", "--bg", "--json", "--reuse", "--name", "worker", "second"],
      second,
    );
    expect(code).toBe(0);
    const payload = stdoutJson<{ conversationId: string; reused: boolean; watermarkStep: number }>(
      second,
    );
    expect(payload).toMatchObject({ conversationId, reused: true, watermarkStep: 3 });

    const steps = readTranscript(instance, conversationId);
    expect(steps).toHaveLength(6);
    expect(String((steps[3] as { content?: string })?.content)).toContain("second");
  });

  it("fills reuse summaries from current flags for sparsely registered rows", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "sparse", "first"], runCtx);
    const conversationId = stdoutJson<{ conversationId: string }>(runCtx).conversationId;

    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.rawExec(
      "UPDATE conversations SET cwd = NULL, model = NULL WHERE conversation_id = ?",
      conversationId,
    );
    store.close();

    const reuseCtx = context(false, { ...instance.env, AG_MOCK_AGENTAPI_MODE: "stuck" });
    const code = await runCli(
      ["run", "--bg", "--json", "--reuse", "--name", "sparse", "--cwd", "/tmp/current", "second"],
      reuseCtx,
    );
    expect(code).toBe(0);
    expect(stdoutJson<{ model: string; cwd: string; title: string }>(reuseCtx)).toMatchObject({
      model: "flash",
      cwd: "/tmp/current",
      title: "sparse",
    });
  });

  it("creates the conversation when --reuse finds no active name", async () => {
    const { instance } = await prepared();
    const ctx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--reuse", "--name", "fresh", "task"], ctx);
    expect(stdoutJson<{ reused: boolean; shortId: string | null }>(ctx)).toMatchObject({
      reused: false,
      shortId: "c1",
    });
  });

  it("rejects name conflicts without --reuse", async () => {
    const { instance } = await prepared();
    const first = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "busy", "one"], first);

    const second = context(false, instance.env);
    const code = await runCli(["run", "--bg", "--json", "--name", "busy", "two"], second);
    expect(code).toBe(1);
    expect(JSON.parse(stderrText(second))).toMatchObject({ error: { kind: "name_conflict" } });
  });

  it("rejects invalid usage", async () => {
    const { instance } = await prepared();
    const noPrompt = context(false, instance.env);
    expect(await runCli(["run", "--bg", "--json"], noPrompt)).toBe(2);

    const reuseWithoutName = context(false, instance.env);
    expect(await runCli(["run", "--bg", "--json", "--reuse", "task"], reuseWithoutName)).toBe(2);

    const badName = context(false, instance.env);
    const badCode = await runCli(["run", "--bg", "--json", "--name", "Bad Name", "task"], badName);
    expect(badCode).toBe(2);
    expect(JSON.parse(stderrText(badName))).toMatchObject({ error: { kind: "invalid_usage" } });

    const badTimeout = context(false, instance.env);
    expect(await runCli(["run", "--bg", "--json", "--timeout", "abc", "task"], badTimeout)).toBe(2);
  });

  it("honors explicit --parent targets and falls back to null with --no-parent", async () => {
    const { instance } = await prepared();
    const explicitParent = "2d2d2d2d-2d2d-42d2-82d2-2d2d2d2d2d2d";
    const db = initSummariesDb(instance);
    db.prepare("INSERT INTO conversation_summaries (conversation_id, title) VALUES (?, ?)").run(
      explicitParent,
      "parent",
    );
    db.close();

    const explicit = context(false, instance.env);
    await runCli(
      ["run", "--bg", "--json", "--parent", explicitParent.slice(0, 8), "child task"],
      explicit,
    );
    expect(stdoutJson<{ parentId: string | null }>(explicit).parentId).toBe(explicitParent);

    const noParent = context(false, { ...instance.env, HC_TERMINAL_ID: "t1" });
    await runCli(["run", "--bg", "--json", "--no-parent", "solo task"], noParent);
    expect(stdoutJson<{ parentId: string | null }>(noParent).parentId).toBeNull();
  });

  it("tolerates project resolution failures", async () => {
    const { instance } = await prepared({ ListProjects: {} }, { ListProjects: 500 });
    const ctx = context(false, instance.env);
    const code = await runCli(["run", "--bg", "--json", "--cwd", "/nope", "task"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ projectId: string | null }>(ctx).projectId).toBeNull();
  });

  it("binds hc terminal callers as parents unless --no-parent is given", async () => {
    const { instance } = await prepared();
    const ctx = context(false, { ...instance.env, HC_TERMINAL_ID: "t3" });
    await runCli(["run", "--bg", "--json", "hc task"], ctx);
    expect(stdoutJson<{ parentId: string | null }>(ctx).parentId).toBe("hc:t3");

    const solo = context(false, { ...instance.env, HC_TERMINAL_ID: "t3" });
    await runCli(["run", "--bg", "--json", "--no-parent", "solo task"], solo);
    expect(stdoutJson<{ parentId: string | null }>(solo).parentId).toBeNull();
  });

  it("validates all run arguments before dispatching anything", async () => {
    const { instance } = await prepared();
    const before = readTranscript(instance, "00000000-0000-4000-8000-000000000000").length;

    const badName = context(false, instance.env);
    expect(await runCli(["run", "--bg", "--json", "--name", "C1", "task"], badName)).toBe(2);

    const badLabel = context(false, instance.env);
    expect(await runCli(["run", "--bg", "--json", "--label", "broken", "task"], badLabel)).toBe(2);

    const tooMany = context(false, instance.env);
    expect(await runCli(["run", "--bg", "--json", "a", "b", "c"], tooMany)).toBe(2);

    const negativeTimeout = context(false, instance.env);
    expect(
      await runCli(["run", "--bg", "--json", "--timeout", "-1", "task"], negativeTimeout),
    ).toBe(2);

    const calls = readMockAgentapiCalls(instance);
    expect(calls.filter((call) => call.command === "new-conversation")).toHaveLength(0);
    expect(before).toBe(0);
  });

  it("records hc terminal parents for hc callers", async () => {
    const { instance } = await prepared();
    const ctx = context(false, { ...instance.env, HC_TERMINAL_ID: "t7" });
    await runCli(["run", "--bg", "--json", "hc task"], ctx);
    const conversationId = stdoutJson<{ conversationId: string }>(ctx).conversationId;

    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.findByConversationId(conversationId)?.parentId).toBe("hc:t7");
    store?.close();
  });

  it("does not reuse conversations killed upstream", async () => {
    const { instance } = await prepared();
    const first = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "upstream-dead", "first"], first);
    const oldId = stdoutJson<{ conversationId: string }>(first).conversationId;
    const db = initSummariesDb(instance);
    db.prepare("UPDATE conversation_summaries SET killed = 1 WHERE conversation_id = ?").run(oldId);
    db.close();

    const second = context(false, instance.env);
    const code = await runCli(
      ["run", "--bg", "--json", "--reuse", "--name", "upstream-dead", "second"],
      second,
    );
    expect(code).toBe(0);
    const payload = stdoutJson<{ conversationId: string; reused: boolean; shortId: string | null }>(
      second,
    );
    expect(payload.reused).toBe(false);
    expect(payload.conversationId).not.toBe(oldId);
    expect(payload.shortId).not.toBe("c1");

    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.findByConversationId(oldId)?.terminated).toBe(1);
    store?.close();
  });

  it("applies labels and titles when reusing", async () => {
    const { instance } = await prepared();
    const first = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "relabel", "first"], first);
    const conversationId = stdoutJson<{ conversationId: string }>(first).conversationId;

    const second = context(false, instance.env);
    await runCli(
      [
        "run",
        "--bg",
        "--json",
        "--reuse",
        "--name",
        "relabel",
        "--label",
        "reuse=yes",
        "--title",
        "second title",
        "second",
      ],
      second,
    );
    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.listLabels(conversationId)).toEqual([{ key: "reuse", value: "yes" }]);
    store?.close();
    expect(readMockAgentapiCalls(instance).some((call) => call.args.includes("--title"))).toBe(
      true,
    );
  });

  it("rolls back the watermark when delivery fails", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "fragile", "first"], runCtx);
    const conversationId = stdoutJson<{ conversationId: string }>(runCtx).conversationId;

    const failing = context(false, {
      ...instance.env,
      AG_CLI_AGENTAPI_BIN: join(instance.root, "missing-bin"),
    });
    const code = await runCli(["send", "fragile", "will fail"], failing);
    expect(code).toBe(4);

    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.findByConversationId(conversationId)?.watermarkStep).toBe(0);
    store?.close();

    const getCtx = context(false, instance.env);
    await runCli(["get", "fragile", "--json"], getCtx);
    expect(stdoutJson<{ status: string }>(getCtx).status).toBe("done");
  });

  it("a failed delivery does not clobber a concurrent successful delivery (review F2)", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "race", "first"], runCtx);
    const conversationId = stdoutJson<{ conversationId: string }>(runCtx).conversationId;

    const marker = join(instance.root, "A-started");
    writeFileSync(
      instance.agentapiBin,
      `#!/usr/bin/env node\nconst fs = require("node:fs");\nif (process.env.R2_MODE === "fail") {\n  fs.writeFileSync(${JSON.stringify(marker)}, "start");\n  setTimeout(() => { process.stderr.write("rejected"); process.exit(1); }, 300);\n} else {\n  process.stdout.write(JSON.stringify({ conversationId: process.argv[4], stepIndex: 2 }));\n}\n`,
      { mode: 0o755 },
    );

    const until = async (condition: () => boolean): Promise<void> => {
      const started = Date.now();
      while (!condition()) {
        if (Date.now() - started > 3000) {
          throw new Error("marker timeout");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    const failingCtx = context(false, { ...instance.env, R2_MODE: "fail" });
    const failing = runCli(["send", "race", "A"], failingCtx);
    await until(() => existsSync(marker));

    // B sends successfully against the real mock behavior encoded above.
    const okCtx = context(false, instance.env);
    const ok = await runCli(["send", "race", "B"], okCtx);
    expect(ok).toBe(0);

    expect(await failing).toBe(1);
    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    const row = store?.findByConversationId(conversationId);
    store?.close();
    expect(row?.watermarkStep).toBe(3);

    const getCtx = context(false, instance.env);
    await runCli(["get", "race", "--json"], getCtx);
    expect(["done", "working"]).toContain(stdoutJson<{ status: string }>(getCtx).status);
  });

  it("a failed adoption does not delete a row another delivery successfully adopted (review F2)", async () => {
    const { instance } = await prepared();
    const created = runAgentapi(instance, ["new-conversation", "--message", "outside"]);
    const outsideId = (JSON.parse(created.stdout) as { conversationId: string }).conversationId;

    const marker = join(instance.root, "B-started");
    writeFileSync(
      instance.agentapiBin,
      `#!/usr/bin/env node\nconst fs = require("node:fs");\nif (process.env.R2_MODE === "fail") {\n  fs.writeFileSync(${JSON.stringify(marker)}, "start");\n  setTimeout(() => { process.exit(1); }, 300);\n} else {\n  process.stdout.write(JSON.stringify({ conversationId: process.argv[4], stepIndex: 1 }));\n}\n`,
      { mode: 0o755 },
    );
    const until = async (condition: () => boolean): Promise<void> => {
      const started = Date.now();
      while (!condition()) {
        if (Date.now() - started > 3000) {
          throw new Error("marker timeout");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    const failingCtx = context(false, { ...instance.env, R2_MODE: "fail" });
    const failing = runCli(["send", outsideId, "A"], failingCtx);
    await until(() => existsSync(marker));

    const okCtx = context(false, instance.env);
    expect(await runCli(["send", outsideId, "B"], okCtx)).toBe(0);
    expect(
      await runCli(["label", outsideId, "concurrent=keep"], context(false, instance.env)),
    ).toBe(0);

    expect(await failing).toBe(1);
    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.findByConversationId(outsideId)).toBeDefined();
    expect(store?.listLabels(outsideId)).toEqual([{ key: "concurrent", value: "keep" }]);
    store?.close();
  });

  it("serializes concurrent same-name runs so only one dispatches (review F3)", async () => {
    const { instance } = await prepared();
    const db = initSummariesDb(instance);
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM conversation_summaries").get() as { n: number }
    ).n;
    const callsBefore = readMockAgentapiCalls(instance).length;

    const slowCtx = context(false, {
      ...instance.env,
      AG_MOCK_AGENTAPI_DELAY_MS: "250",
    });
    const slow = runCli(["run", "--bg", "--json", "--name", "collision", "A"], slowCtx);
    const slowStarted = Date.now();
    while (readMockAgentapiCalls(instance).length <= callsBefore) {
      if (Date.now() - slowStarted > 3000) {
        throw new Error("first run never dispatched");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const fastCtx = context(false, instance.env);
    const fast = await runCli(["run", "--bg", "--json", "--name", "collision", "B"], fastCtx);
    expect(fast).toBe(1);
    expect(JSON.parse(stderrText(fastCtx))).toMatchObject({ error: { kind: "name_conflict" } });

    expect(await slow).toBe(0);
    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM conversation_summaries").get() as { n: number }
    ).n;
    expect(after - before).toBe(1);
    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.listManaged().length).toBe(1);
    store?.close();
    db.close();
  });

  it("never dispatches after a reservation timeout when no active name exists (review R3 F3)", async () => {
    const { instance } = await prepared();
    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.acquireNameReservation("slow-name", "another-process");
    store.close();

    const callsBefore = readMockAgentapiCalls(instance).length;
    const ctx = context(false, instance.env);
    const started = Date.now();
    const code = await runCli(
      ["run", "--reuse", "--bg", "--json", "--name", "slow-name", "--timeout", "1", "task"],
      ctx,
    );
    expect(code).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({ error: { kind: "name_conflict" } });
    expect(readMockAgentapiCalls(instance).length).toBe(callsBefore);
  }, 15_000);

  it("recovers names from stale reservations on the next run (review R3 F3)", async () => {
    const { instance } = await prepared();
    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.acquireNameReservation("orphan", "dead-token");
    store.rawExec(
      "UPDATE name_reservations SET created_at = '2000-01-01T00:00:00Z' WHERE name = 'orphan'",
    );
    store.close();

    const ctx = context(false, instance.env);
    const code = await runCli(["run", "--bg", "--json", "--name", "orphan", "task"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ name: string | null }>(ctx).name).toBe("orphan");
  });

  it("run --reuse on a terminated stale alias creates cleanly without dispatching twice (review F3)", async () => {
    const { instance } = await prepared();
    const first = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "stale", "one"], first);
    const conversationId = stdoutJson<{ conversationId: string }>(first).conversationId;

    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.markTerminated(conversationId);
    // simulate an externally terminated row that still holds the name
    store.rawExec(
      "UPDATE conversations SET name = ? WHERE conversation_id = ?",
      "stale",
      conversationId,
    );
    store.close();

    const db = initSummariesDb(instance);
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM conversation_summaries").get() as { n: number }
    ).n;
    const reuse = context(false, instance.env);
    const code = await runCli(
      ["run", "--bg", "--json", "--reuse", "--name", "stale", "two"],
      reuse,
    );
    expect(code).toBe(0);
    expect(stdoutJson<{ reused: boolean }>(reuse).reused).toBe(false);
    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM conversation_summaries").get() as { n: number }
    ).n;
    expect(after - before).toBe(1);
    db.close();
  });

  it("rejects two positionals until templates ship", async () => {
    const { instance } = await prepared();
    const ctx = context(false, instance.env);
    const code = await runCli(["run", "--bg", "--json", "some-template", "do the thing"], ctx);
    expect(code).toBe(1);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({
      error: { kind: "not_found", message: expect.stringContaining("template") },
    });
  });

  it("fails with daemon_unavailable when no daemon is healthy", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const ctx = context(false, instance.env);
    const code = await runCli(["run", "--bg", "--json", "task"], ctx);
    expect(code).toBe(4);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({ error: { kind: "daemon_unavailable" } });
  });

  it("advances lastTurn for --bg runs on the next observation (review P3-31)", async () => {
    const { instance } = await prepared();
    const ctx = context(false, {
      ...instance.env,
      AG_MOCK_AGENTAPI_ASYNC: "1",
      AG_MOCK_AGENTAPI_ASYNC_DELAY_MS: "150",
    });
    await runCli(["run", "--bg", "--json", "--name", "bg-turn", "task"], ctx);
    const conversationId = stdoutJson<{ conversationId: string }>(ctx).conversationId;

    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.findByConversationId(conversationId)?.lastTurn).toBe(0);
    store?.close();

    await new Promise((resolve) => setTimeout(resolve, 700));
    const getCtx = context(false, instance.env);
    await runCli(["get", "bg-turn", "--json"], getCtx);
    const reloaded = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(reloaded?.findByConversationId(conversationId)?.lastTurn).toBe(1);
    reloaded?.close();
  });

  it("renders tty text summaries for synchronous runs", async () => {
    const { instance } = await prepared();
    const ctx = context(true, instance.env);
    const code = await runCli(["run", "--name", "tty-run", "task"], ctx);
    expect(code).toBe(0);
    const text = stdoutText(ctx);
    expect(text).toContain("c1 (tty-run) · done");
    expect(text).toContain("conversationId:");
  });

  it("renders tty timeouts with names and previews for children waits", async () => {
    const { instance } = await prepared();
    const parent = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
    const child = (
      JSON.parse(
        runAgentapi(instance, ["new-conversation", "--message", "stuck"], {
          AG_MOCK_AGENTAPI_MODE: "stuck",
        }).stdout,
      ) as { conversationId: string }
    ).conversationId;
    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.registerConversation(child, { name: "stuck-kid", parentId: parent });
    store.close();
    const db = initSummariesDb(instance);
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title) VALUES (?, ?)" +
        " ON CONFLICT(conversation_id) DO NOTHING",
    ).run(parent, "owner");
    db.close();

    const ctx = context(true, { ...instance.env, AG_CLI_CALLER_ID: parent });
    const code = await runCli(["wait", "--children", "any", "--timeout", "1"], ctx);
    expect(code).toBe(124);
    const text = stdoutText(ctx);
    expect(text).toContain("d4d4d4d4");
    expect(text).toContain("(timeout)");
  }, 10_000);

  it("waits synchronously without --bg and reports the settled status", async () => {
    const { instance } = await prepared();
    const ctx = context(true, instance.env);
    const code = await runCli(["run", "--name", "sync-run", "quick task"], ctx);
    expect(code).toBe(0);
    const text = stdoutText(ctx);
    expect(text).toContain("c1");
    expect(text).toContain("sync-run");
    expect(text).toContain("done");
  });

  it("returns exit 124 when the synchronous wait times out", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, { ...instance.env, AG_MOCK_AGENTAPI_MODE: "stuck" });
    await runCli(["run", "--bg", "--json", "--name", "stuck-runner", "slow"], runCtx);

    const syncCtx = context(false, { ...instance.env, AG_MOCK_AGENTAPI_MODE: "stuck" });
    const syncCode = await runCli(
      ["run", "--reuse", "--json", "--name", "stuck-runner", "--timeout", "1", "still slow"],
      syncCtx,
    );
    expect(syncCode).toBe(124);
    expect(stdoutJson<{ reason: string; timedOut: boolean }>(syncCtx)).toMatchObject({
      reason: "timeout",
      timedOut: true,
    });

    const waitCtx = context(false, { ...instance.env, AG_MOCK_AGENTAPI_MODE: "stuck" });
    const waitCode = await runCli(
      ["send", "--wait", "--json", "--timeout", "1", "c1", "nudge"],
      waitCtx,
    );
    expect(waitCode).toBe(124);
    expect(stdoutJson<{ reason: string; timedOut: boolean }>(waitCtx)).toMatchObject({
      reason: "timeout",
      timedOut: true,
    });
  }, 20000);
});

describe("send command", () => {
  it("sends to a managed conversation and persists the watermark before delivery", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "worker", "first"], runCtx);
    const conversationId = stdoutJson<{ conversationId: string }>(runCtx).conversationId;

    const ctx = context(false, instance.env);
    const code = await runCli(["send", "c1", "second turn"], ctx);
    expect(code).toBe(0);
    expect(
      stdoutJson<{
        conversationId: string;
        shortId: string;
        watermarkStep: number;
        queued: boolean;
      }>(ctx),
    ).toMatchObject({
      conversationId,
      shortId: "c1",
      watermarkStep: 3,
      queued: false,
    });

    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.findByConversationId(conversationId)?.watermarkStep).toBe(3);
    store?.close();
  });

  it("auto-registers unmanaged uuid targets so watermarks are tracked", async () => {
    const { instance } = await prepared();
    const created = runAgentapi(instance, ["new-conversation", "--message", "outside"]);
    const outsideId = (JSON.parse(created.stdout) as { conversationId: string }).conversationId;

    const ctx = context(false, instance.env);
    const code = await runCli(["send", outsideId, "now managed"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ watermarkStep: number; queued: boolean }>(ctx)).toMatchObject({
      watermarkStep: 3,
    });

    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.findByConversationId(outsideId)).toMatchObject({ shortId: 1, watermarkStep: 3 });
    store?.close();
  });

  it("enforces --if preconditions with exit 3", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "worker", "first"], runCtx);

    const ok = context(false, instance.env);
    expect(await runCli(["send", "--if", "done", "worker", "ok"], ok)).toBe(0);

    const mismatch = context(false, instance.env);
    const code = await runCli(["send", "--if", "idle", "worker", "nope"], mismatch);
    expect(code).toBe(3);
    expect(JSON.parse(stderrText(mismatch))).toMatchObject({
      error: { kind: "precondition_failed" },
    });
  });

  it("rejects blocked conversations without --force", async () => {
    const { instance } = await prepared();
    const created = runAgentapi(instance, ["new-conversation", "--message", "stuck"], {
      AG_MOCK_AGENTAPI_MODE: "blocked",
    });
    const blockedId = (JSON.parse(created.stdout) as { conversationId: string }).conversationId;

    const rejected = context(false, instance.env);
    const code = await runCli(["send", blockedId, "answer"], rejected);
    expect(code).toBe(1);
    expect(JSON.parse(stderrText(rejected))).toMatchObject({
      error: { kind: "blocked_conversation" },
    });

    const forced = context(false, instance.env);
    expect(await runCli(["send", "--force", blockedId, "answer"], forced)).toBe(0);
  });

  it("marks queued sends to working conversations", async () => {
    const { instance } = await prepared();
    const created = runAgentapi(instance, ["new-conversation", "--message", "slow"], {
      AG_MOCK_AGENTAPI_MODE: "stuck",
    });
    const stuckId = (JSON.parse(created.stdout) as { conversationId: string }).conversationId;

    const ctx = context(false, instance.env);
    const code = await runCli(["send", stuckId, "queue me"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ queued: boolean }>(ctx).queued).toBe(true);
  });

  it("rejects missing targets, messages and invalid timeouts", async () => {
    const { instance } = await prepared();
    const noTarget = context(false, instance.env);
    expect(await runCli(["send"], noTarget)).toBe(2);

    const emptyTarget = context(false, instance.env);
    expect(await runCli(["send", "", "m"], emptyTarget)).toBe(2);

    const emptyText = context(false, instance.env);
    expect(await runCli(["send", "c1", ""], emptyText)).toBe(2);

    const noText = context(false, instance.env);
    expect(await runCli(["send", "c1"], noText)).toBe(2);

    const badTimeout = context(false, instance.env);
    expect(await runCli(["send", "--wait", "--timeout", "x", "c1", "m"], badTimeout)).toBe(2);

    const unknown = context(false, instance.env);
    const code = await runCli(["send", "c9", "hi"], unknown);
    expect(code).toBe(1);
    expect(JSON.parse(stderrText(unknown))).toMatchObject({ error: { kind: "not_found" } });
  });

  it("wraps outbound messages for antigravity callers", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "worker", "first"], runCtx);
    const conversationId = stdoutJson<{ conversationId: string }>(runCtx).conversationId;

    const ctx = context(false, { ...instance.env, ANTIGRAVITY_CONVERSATION_ID: conversationId });
    const code = await runCli(["send", "c1", "report back"], ctx);
    expect(code).toBe(0);
    const steps = readTranscript(instance, conversationId);
    expect(String(steps[3]?.content)).toContain('<ag-cli from="c1 ');
    expect(String(steps[3]?.content)).toContain(`reach="ag-cli send ${conversationId}`);

    const orphanCaller = context(false, {
      ...instance.env,
      ANTIGRAVITY_CONVERSATION_ID: "3e3e3e3e-3e3e-43e3-83e3-3e3e3e3e3e3e",
    });
    expect(await runCli(["send", "c1", "plain reply"], orphanCaller)).toBe(0);
    const wrapped = readTranscript(instance, conversationId).at(-1);
    expect(String(wrapped?.content)).toContain(
      '<ag-cli from="3e3e3e3e-3e3e-43e3-83e3-3e3e3e3e3e3e"',
    );
  });

  it("rejects invalid --if values and renders text receipts on a tty", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "worker", "first"], runCtx);

    const badIf = context(false, instance.env);
    expect(await runCli(["send", "--if", "bogus", "worker", "x"], badIf)).toBe(2);

    const tty = context(true, instance.env);
    const code = await runCli(["send", "worker", "plain receipt"], tty);
    expect(code).toBe(0);
    expect(stdoutText(tty)).toContain("sent to c1 (worker)");
    expect(stdoutText(tty)).toContain("watermark 3");
  });

  it("reports nameless preconditions and text receipts", async () => {
    const { instance } = await prepared();
    const created = runAgentapi(instance, ["new-conversation", "--message", "slow"], {
      AG_MOCK_AGENTAPI_MODE: "stuck",
    });
    const stuckId = (JSON.parse(created.stdout) as { conversationId: string }).conversationId;

    const mismatch = context(false, instance.env);
    const code = await runCli(["send", "--if", "idle", stuckId, "nope"], mismatch);
    expect(code).toBe(3);
    expect(JSON.parse(stderrText(mismatch)).error.message).not.toContain("(");

    const tty = context(true, instance.env);
    expect(await runCli(["send", stuckId, "queued text"], tty)).toBe(0);
    expect(stdoutText(tty)).toContain("sent to c1 · watermark 1 · queued");
  });

  it("removes auto-registered rows when an unmanaged send fails", async () => {
    const { instance } = await prepared();
    const created = runAgentapi(instance, ["new-conversation", "--message", "outside"]);
    const outsideId = (JSON.parse(created.stdout) as { conversationId: string }).conversationId;

    const failing = context(false, {
      ...instance.env,
      AG_CLI_AGENTAPI_BIN: join(instance.root, "missing-bin"),
    });
    expect(await runCli(["send", outsideId, "fail"], failing)).toBe(4);

    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.findByConversationId(outsideId)).toBeUndefined();
    store?.close();
  });

  it("renders tty timeouts for nameless runs and sends", async () => {
    const { instance } = await prepared();
    const env = { ...instance.env, AG_MOCK_AGENTAPI_MODE: "stuck" };
    const runCtx = context(true, env);
    const code = await runCli(["run", "--timeout", "1", "slow task"], runCtx);
    expect(code).toBe(124);
    const text = stderrText(runCtx);
    expect(text).toContain("still working as c1");

    const sendCtx = context(true, env);
    expect(await runCli(["send", "--wait", "--timeout", "1", "c1", "nudge"], sendCtx)).toBe(124);
    expect(stderrText(sendCtx)).toContain("still working");
  }, 15000);

  it("waits for turn completion with --wait", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "worker", "first"], runCtx);

    const ctx = context(false, instance.env);
    const code = await runCli(["send", "--wait", "worker", "second"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ reason: string; status: string }>(ctx)).toMatchObject({
      reason: "done",
      status: "done",
    });
  });
});

describe("label command", () => {
  it("sets, overwrites and removes labels", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "labeled", "task"], runCtx);

    const set = context(false, instance.env);
    await runCli(["label", "labeled", "env=prod", "team=gravity"], set);
    expect(stdoutJson<{ labels: Record<string, string> }>(set).labels).toEqual({
      env: "prod",
      team: "gravity",
    });

    const overwrite = context(false, instance.env);
    await runCli(["label", "labeled", "env=staging"], overwrite);
    expect(stdoutJson<{ labels: Record<string, string> }>(overwrite).labels).toEqual({
      env: "staging",
      team: "gravity",
    });

    const remove = context(false, instance.env);
    await runCli(["label", "labeled", "env="], remove);
    expect(stdoutJson<{ labels: Record<string, string> }>(remove).labels).toEqual({
      team: "gravity",
    });
  });

  it("reports shortId as a cN string consistently with other commands (review F18)", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "labeled", "task"], runCtx);

    const set = context(false, instance.env);
    await runCli(["label", "labeled", "env=prod"], set);
    expect(stdoutJson<{ shortId: string; name: string }>(set)).toMatchObject({
      shortId: "c1",
      name: "labeled",
    });

    const kill = context(false, instance.env);
    await runCli(["kill", "labeled", "--json"], kill);
    expect(stdoutJson<{ shortId: string; terminated: boolean }>(kill)).toMatchObject({
      shortId: "c1",
      terminated: true,
    });

    const rm = context(false, instance.env);
    await runCli(["rm", "c1", "--json"], rm);
    expect(stdoutJson<{ shortId: string; removed: boolean }>(rm)).toMatchObject({
      shortId: "c1",
      removed: true,
    });

    const created = runAgentapi(instance, ["new-conversation", "--message", "plain"]);
    const plainId = (JSON.parse(created.stdout) as { conversationId: string }).conversationId;
    const interrupt = context(false, instance.env);
    await runCli(["interrupt", plainId, "--json"], interrupt);
    expect(stdoutJson<{ shortId: string | null; interrupted: boolean }>(interrupt)).toMatchObject({
      shortId: null,
      interrupted: true,
    });
  });

  it("rejects invalid syntax and missing pairs", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "labeled", "task"], runCtx);

    const noTarget = context(false, instance.env);
    expect(await runCli(["label"], noTarget)).toBe(2);

    const none = context(false, instance.env);
    expect(await runCli(["label", "labeled"], none)).toBe(2);

    const bad = context(false, instance.env);
    const code = await runCli(["label", "labeled", "oops"], bad);
    expect(code).toBe(2);
    expect(JSON.parse(stderrText(bad))).toMatchObject({ error: { kind: "invalid_usage" } });

    const unknown = context(false, instance.env);
    expect(await runCli(["label", "c9", "a=b"], unknown)).toBe(1);
  });

  it("renders text receipts on a tty", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "labeled", "task"], runCtx);

    const tty = context(true, instance.env);
    const code = await runCli(["label", "labeled", "env=prod"], tty);
    expect(code).toBe(0);
    expect(stdoutText(tty)).toContain("labels on c1: env=prod");

    const cleared = context(true, instance.env);
    expect(await runCli(["label", "labeled", "env="], cleared)).toBe(0);
    expect(stdoutText(cleared)).toContain("labels on c1: -");
  });
});

describe("control commands", () => {
  it("interrupt cancels the running turn through the language server", async () => {
    const { instance, server } = await prepared({
      responses: { CancelCascadeInvocation: {} },
    });
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "runner", "task"], runCtx);
    const conversationId = stdoutJson<{ conversationId: string }>(runCtx).conversationId;

    const ctx = context(false, instance.env);
    const code = await runCli(["interrupt", "runner"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ interrupted: boolean }>(ctx).interrupted).toBe(true);
    expect(
      server.rpcCalls.find((call) => call.method === "CancelCascadeInvocation")?.body,
    ).toMatchObject({ conversationId });
  });

  it("interrupt fails clearly without a healthy daemon", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const created = runAgentapi(instance, ["new-conversation", "--message", "x"]);
    const conversationId = (JSON.parse(created.stdout) as { conversationId: string })
      .conversationId;
    const ctx = context(false, instance.env);
    const code = await runCli(["interrupt", conversationId], ctx);
    expect(code).toBe(4);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({ error: { kind: "daemon_unavailable" } });
  });

  it("requires a target for control verbs", async () => {
    const { instance } = await prepared();
    for (const verb of ["interrupt", "kill", "rm"]) {
      const ctx = context(false, instance.env);
      expect(await runCli([verb], ctx)).toBe(2);
    }
  });

  it("kill still terminates when the daemon is unreachable", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const created = runAgentapi(instance, ["new-conversation", "--message", "x"]);
    const conversationId = (JSON.parse(created.stdout) as { conversationId: string })
      .conversationId;

    const ctx = context(false, instance.env);
    const code = await runCli(["kill", conversationId], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ terminated: boolean }>(ctx).terminated).toBe(true);

    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.findByConversationId(conversationId)?.terminated).toBe(1);
    store?.close();
  });

  it("renders text receipts for control verbs on a tty", async () => {
    const { instance } = await prepared({ CancelCascadeInvocation: {} });
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "tty-runner", "task"], runCtx);

    const interruptCtx = context(true, instance.env);
    expect(await runCli(["interrupt", "tty-runner"], interruptCtx)).toBe(0);
    expect(stdoutText(interruptCtx)).toContain("interrupted: true");

    const rmCtx = context(true, instance.env);
    expect(await runCli(["rm", "tty-runner"], rmCtx)).toBe(0);
    expect(stdoutText(rmCtx)).toContain("removed: true");
    expect(stdoutText(rmCtx)).toContain("purgedBrain: false");
  });

  it("kill marks the conversation terminated and keeps it addressable", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "doomed", "task"], runCtx);
    const conversationId = stdoutJson<{ conversationId: string }>(runCtx).conversationId;

    const ctx = context(false, instance.env);
    const code = await runCli(["kill", "doomed"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ terminated: boolean }>(ctx).terminated).toBe(true);

    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.findByConversationId(conversationId)?.terminated).toBe(1);
    store?.close();

    const lsCtx = context(false, instance.env);
    await runCli(["ls"], lsCtx);
    expect(stdoutJson<Array<unknown>>(lsCtx)).toEqual([]);
  });

  it("rm unregisters and only purges brain files with --purge-brain", async () => {
    const { instance } = await prepared();
    const first = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "keep-brain", "one"], first);
    const keepId = stdoutJson<{ conversationId: string }>(first).conversationId;
    const second = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "purge-me", "two"], second);
    const purgeId = stdoutJson<{ conversationId: string }>(second).conversationId;

    const keepCtx = context(false, instance.env);
    expect(await runCli(["rm", "keep-brain"], keepCtx)).toBe(0);
    expect(existsSync(join(instance.brainDir, keepId))).toBe(true);

    const purgeCtx = context(false, instance.env);
    expect(await runCli(["rm", "--purge-brain", "purge-me"], purgeCtx)).toBe(0);
    expect(stdoutJson<{ purgedBrain: boolean }>(purgeCtx).purgedBrain).toBe(true);
    expect(existsSync(join(instance.brainDir, purgeId))).toBe(false);

    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.findByConversationId(keepId)).toBeUndefined();
    expect(
      readFileSync(
        join(instance.brainDir, keepId, ".system_generated", "logs", "transcript.jsonl"),
        "utf8",
      ),
    ).toContain("one");
    store?.close();
  });

  it("refuses --purge-brain when the brain path escapes its root", async () => {
    const { instance } = await prepared();
    const runCtx = context(false, instance.env);
    await runCli(["run", "--bg", "--json", "--name", "sneaky", "task"], runCtx);
    const conversationId = stdoutJson<{ conversationId: string }>(runCtx).conversationId;

    const outside = join(instance.root, "outside-target");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "keep");
    const brainPath = join(instance.brainDir, conversationId);
    rmSync(brainPath, { recursive: true, force: true });
    symlinkSync(outside, brainPath);

    const ctx = context(false, instance.env);
    const code = await runCli(["rm", "--purge-brain", "sneaky"], ctx);
    expect(code).toBe(2);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({ error: { kind: "invalid_usage" } });
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);

    const store = StateStore.open(join(instance.agCliHome, "state.db"));
    expect(store?.findByConversationId(conversationId)).toBeDefined();
    store?.close();
  });

  it("rm of an unregistered conversation fails with not_found", async () => {
    const { instance } = await prepared();
    const ctx = context(false, instance.env);
    const code = await runCli(["rm", "c404"], ctx);
    expect(code).toBe(1);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({ error: { kind: "not_found" } });
  });
});
