import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectBrainIds, observeConversation } from "../../src/cli/commands/registry";
import type { StreamLike } from "../../src/cli/format";
import { type CliContext, parseCommandFlags, runCli } from "../../src/cli/index";
import { resolvePaths } from "../../src/infra/paths";
import { StateStore } from "../../src/infra/state-store";
import {
  createSandbox,
  initSummariesDb,
  runAgentapi,
  type Sandbox,
  startMockLanguageServer,
  writeHubFile,
  writeMockAgentapi,
} from "../helpers/sandbox";

const active: Sandbox[] = [];
const openServers: Array<{ close(): Promise<void> }> = [];

function sandbox(): Sandbox {
  const created = createSandbox("ag-cli-unit-cli");
  active.push(created);
  return created;
}

function context(tty: boolean, env: Record<string, string> = {}): CliContext {
  const make = (): StreamLike => {
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

async function prepareConversation(instance: Sandbox, message = "upgrade deps"): Promise<string> {
  initSummariesDb(instance);
  writeMockAgentapi(instance);
  const result = runAgentapi(instance, ["new-conversation", "--title", "deps job", message]);
  expect(result.status).toBe(0);
  return (JSON.parse(result.stdout) as { conversationId: string }).conversationId;
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await server.close();
  }
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

describe("registry helpers", () => {
  it("returns no brain ids for a missing brain dir and tolerates missing transcripts", async () => {
    const instance = sandbox();
    expect(collectBrainIds(join(instance.root, "no-such-brain"))).toEqual([]);

    const brainOnly = "12121212-1212-4121-8121-121212121212";
    mkdirSync(join(instance.brainDir, brainOnly), { recursive: true });

    const ctx = context(false, instance.env);
    const code = await runCli(["get", brainOnly, "--json"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ status: string; telemetry: { stepCount: number } }>(ctx)).toMatchObject({
      status: "idle",
      telemetry: { stepCount: 0 },
    });
  });

  it("observes conversations without a summaries reader", () => {
    const instance = sandbox();
    const brainOnly = "13131313-1313-4131-8131-131313131313";
    const logs = join(instance.brainDir, brainOnly, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "transcript.jsonl"),
      `${JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "q" })}\n${JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "a" })}\n`,
    );

    const paths = resolvePaths(instance.env);
    const observation = observeConversation(paths, null, brainOnly);
    expect(observation.status).toBe("idle");
    expect(observation.telemetry.stepCount).toBe(2);
  });

  it("ignores artifact feedback requests that already completed", () => {
    const instance = sandbox();
    const paths = resolvePaths(instance.env);
    const conversationId = "16161616-1616-4161-8161-161616161616";
    const logs = join(instance.brainDir, conversationId, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "transcript.jsonl"),
      `${JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "q" })}\n${JSON.stringify({ step_index: 1, type: "GENERIC", status: "DONE", tool_calls: [{ name: "review_artifact", status: "DONE", arguments: { RequestFeedback: true } }] })}\n${JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", content: "a" })}\n`,
    );
    const observation = observeConversation(paths, null, conversationId);
    expect(observation.status).toBe("idle");
  });

  it("advances lastTurn only for turns with a completed planner reply (review R3 P3-31)", () => {
    const instance = sandbox();
    const paths = resolvePaths(instance.env);
    const store = StateStore.open(paths.stateDbPath, { create: true });
    const conversationId = "15151515-1515-4151-8151-151515151515";
    store.registerConversation(conversationId, { name: "in-flight" });
    const logs = join(instance.brainDir, conversationId, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "transcript.jsonl"),
      `${JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "started" })}\n`,
    );
    try {
      observeConversation(paths, null, conversationId, store);
      expect(store.findByConversationId(conversationId)?.lastTurn).toBe(0);

      writeFileSync(
        join(logs, "transcript.jsonl"),
        `${JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "started" })}\n${JSON.stringify({ step_index: 1, type: "GENERIC", status: "RUNNING" })}\n${JSON.stringify({ step_index: 2, type: "USER_INPUT", status: "DONE", content: "second" })}\n${JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", content: "first done" })}\n`,
      );
      observeConversation(paths, null, conversationId, store);
      expect(store.findByConversationId(conversationId)?.lastTurn).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("state-backed conversations", () => {
  it("lists managed conversations with short ids, names and labels", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);
    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.registerConversation(conversationId, { name: "deps-clip", cwd: "/tmp/clip" });
    store.setLabels(conversationId, ["task=deps", "repo=clip"]);
    store.close();

    const ctx = context(false, instance.env);
    const code = await runCli(["ls"], ctx);
    expect(code).toBe(0);
    const rows =
      stdoutJson<
        Array<{
          shortId: string;
          name: string;
          labels: Record<string, string>;
          project: string;
          status: string;
        }>
      >(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shortId: "c1",
      name: "deps-clip",
      labels: { task: "deps", repo: "clip" },
      project: "/tmp/clip",
      status: "done",
    });
  });

  it("filters by repeated --label pairs with AND semantics", async () => {
    const instance = sandbox();
    const first = await prepareConversation(instance, "first");
    runAgentapi(instance, ["new-conversation", "second"]);
    const second = "";
    expect(second).toBe("");
    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    const secondRow = store.listManaged().length; // no rows yet
    expect(secondRow).toBe(0);
    const summaries = (await import("../../src/infra/summaries-reader")).openSummariesReader(
      instance.summariesDbPath,
    );
    const allIds = summaries?.listConversations().map((row) => row.conversation_id) ?? [];
    summaries?.close();
    store.registerConversation(first, { name: "first" });
    store.setLabels(first, ["task=a", "repo=x"]);
    const other = allIds.find((id) => id !== first) as string;
    store.registerConversation(other, { name: "second" });
    store.setLabels(other, ["task=a", "repo=y"]);
    store.close();

    const bothCtx = context(false, instance.env);
    await runCli(["ls", "--label", "task=a"], bothCtx);
    expect(stdoutJson<Array<{ name: string }>>(bothCtx)).toHaveLength(2);

    const narrowCtx = context(false, instance.env);
    await runCli(["ls", "--label", "task=a", "--label", "repo=y"], narrowCtx);
    const narrow = stdoutJson<Array<{ name: string }>>(narrowCtx);
    expect(narrow).toHaveLength(1);
    expect(narrow[0]?.name).toBe("second");

    const noneCtx = context(false, instance.env);
    await runCli(["ls", "--label", "task=zzz"], noneCtx);
    expect(stdoutJson<Array<unknown>>(noneCtx)).toEqual([]);

    const badCtx = context(false, instance.env);
    const badCode = await runCli(["ls", "--label", "nope"], badCtx);
    expect(badCode).toBe(2);
    expect(JSON.parse(stderrText(badCtx))).toMatchObject({ error: { kind: "invalid_usage" } });
  });

  it("filters children by caller id across state and summaries", async () => {
    const instance = sandbox();
    const parentId = "16161616-1616-4161-8161-161616161616";
    const child = await prepareConversation(instance);
    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.registerConversation(child, { name: "child-a", parentId });
    const orphan = "17171717-1717-4171-8171-171717171717";
    store.registerConversation(orphan, { name: "orphan" });
    store.close();
    const db = initSummariesDb(instance);
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, parent_conversation_id, last_modified_time) VALUES (?, ?, ?, ?)",
    ).run(
      "18181818-1818-4181-8181-181818181818",
      "summary-child",
      parentId,
      "2026-11-14T09:00:00Z",
    );
    db.close();

    const ctx = context(false, { ...instance.env, AG_CLI_CALLER_ID: parentId });
    const code = await runCli(["ls", "--children"], ctx);
    expect(code).toBe(0);
    const rows = stdoutJson<Array<{ conversationId: string }>>(ctx);
    expect(rows.map((row) => row.conversationId).sort()).toEqual(
      [child, "18181818-1818-4181-8181-181818181818"].sort(),
    );
  });

  it("requires a caller for --children", async () => {
    const instance = sandbox();
    const ctx = context(false, instance.env);
    const code = await runCli(["ls", "--children"], ctx);
    expect(code).toBe(2);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({ error: { kind: "invalid_usage" } });
  });

  it("hides terminated managed conversations unless --all", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);
    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.registerConversation(conversationId, { name: "doomed" });
    store.markTerminated(conversationId);
    store.close();

    const defaultCtx = context(false, instance.env);
    await runCli(["ls"], defaultCtx);
    expect(stdoutJson<Array<unknown>>(defaultCtx)).toEqual([]);

    const allCtx = context(false, instance.env);
    await runCli(["ls", "--all"], allCtx);
    const rows =
      stdoutJson<Array<{ shortId: string; status: string; terminated: boolean }>>(allCtx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shortId: "c1", status: "error", terminated: true });
  });

  it("reflects shortId, name, labels, parentId and watermark in get and read", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);
    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.registerConversation(conversationId, {
      name: "ui-check",
      parentId: "19191919-1919-4191-8191-191919191919",
    });
    store.setLabels(conversationId, ["env=prod"]);
    store.beginDelivery(conversationId, 0);
    store.close();

    const getCtx = context(false, instance.env);
    await runCli(["get", "ui-check", "--json"], getCtx);
    expect(
      stdoutJson<{
        shortId: number;
        name: string;
        parentId: string;
        watermarkStep: number;
        labels: Record<string, string>;
        status: string;
      }>(getCtx),
    ).toMatchObject({
      shortId: "c1",
      name: "ui-check",
      parentId: "19191919-1919-4191-8191-191919191919",
      watermarkStep: 0,
      labels: { env: "prod" },
      status: "done",
    });

    const readCtx = context(false, instance.env);
    await runCli(["read", "c1", "--json"], readCtx);
    expect(
      stdoutJson<{
        shortId: number;
        name: string;
        labels: Record<string, string>;
        parentId: string;
      }>(readCtx),
    ).toMatchObject({
      shortId: "c1",
      name: "ui-check",
      labels: { env: "prod" },
      parentId: "19191919-1919-4191-8191-191919191919",
    });
  });

  it("reflects summary parents for unmanaged reads", async () => {
    const instance = sandbox();
    const parentId = "1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a";
    const db = initSummariesDb(instance);
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, parent_conversation_id, last_modified_time) VALUES (?, ?, ?, ?)",
    ).run(
      "1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b",
      "unmanaged child",
      parentId,
      "2026-11-14T10:00:00Z",
    );
    db.close();

    const ctx = context(false, instance.env);
    await runCli(["read", "1b1b1b1b", "--json"], ctx);
    expect(stdoutJson<{ parentId: string | null }>(ctx).parentId).toBe(parentId);
  });

  it("renders labels in tty get output", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);
    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.registerConversation(conversationId, { name: "observed" });
    store.setLabels(conversationId, ["env=prod"]);
    store.close();

    const ctx = context(true, instance.env);
    const code = await runCli(["get", "observed"], ctx);
    expect(code).toBe(0);
    expect(stdoutText(ctx)).toContain("labels: env=prod");
  });

  it("lists managed rows missing from summaries", async () => {
    const instance = sandbox();
    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.registerConversation("bfbfbfbf-bfbf-4fbf-8fbf-bfbfbfbfbfbf", { name: "ghost-managed" });
    store.close();

    const ctx = context(false, instance.env);
    await runCli(["ls"], ctx);
    const rows =
      stdoutJson<Array<{ shortId: string; name: string; stepCount: number; project: string }>>(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shortId: "c1",
      name: "ghost-managed",
      stepCount: 0,
      project: "",
    });
  });

  it("renders tty headers with short ids and names for managed conversations", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);
    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.registerConversation(conversationId, { name: "tty-worker" });
    store.close();

    const ctx = context(true, instance.env);
    const code = await runCli(["read", "tty-worker"], ctx);
    expect(code).toBe(0);
    expect(stdoutText(ctx)).toContain("# c1 (tty-worker)");
  });

  it("surfaces generic runtime errors as exit 1", async () => {
    const instance = sandbox();
    writeFileSync(instance.summariesDbPath, "definitely not sqlite");

    const ctx = context(false, instance.env);
    const code = await runCli(["ls"], ctx);
    expect(code).toBe(1);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({ error: { kind: "runtime_error" } });
  });

  it("reports managed counts in status", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);
    const store = StateStore.open(join(instance.agCliHome, "state.db"), { create: true });
    store.registerConversation(conversationId, { name: "watched" });
    store.close();

    const ctx = context(false, instance.env);
    await runCli(["status", "--json"], ctx);
    expect(
      stdoutJson<{ stateDb: { present: boolean; managed: number } }>(ctx).stateDb,
    ).toMatchObject({
      present: true,
      managed: 1,
    });
  });
});

describe("parseCommandFlags", () => {
  it("splits booleans, values and positionals", () => {
    const parsed = parseCommandFlags(["--steps", "--lines", "3", "c7", "extra"], {
      booleans: ["steps"],
      values: ["lines"],
    });
    expect([...parsed.flags]).toEqual(["steps"]);
    expect(parsed.values.get("lines")).toBe("3");
    expect(parsed.positionals).toEqual(["c7", "extra"]);
  });

  it("rejects unknown flags with invalid_usage", () => {
    expect(() => parseCommandFlags(["--nope"], { booleans: [], values: [] }).flags.size).toThrow();
  });

  it("rejects value flags without a value", () => {
    expect(() => parseCommandFlags(["--lines"], { booleans: [], values: ["lines"] })).toThrow();
  });

  it("treats repeated flags as last-wins and keeps order of positionals", () => {
    const parsed = parseCommandFlags(["a", "--lines", "1", "--lines", "7", "b"], {
      booleans: [],
      values: ["lines"],
    });
    expect(parsed.values.get("lines")).toBe("7");
    expect(parsed.positionals).toEqual(["a", "b"]);
  });
});

describe("strict parsing", () => {
  it("supports -- to pass option-like positionals and subcommand help", async () => {
    const instance = sandbox();
    const ctx = context(false, instance.env);
    expect(await runCli(["get", "--", "--weird-target"], ctx)).toBe(2);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({
      error: { message: expect.stringContaining("--weird-target") },
    });

    const help = context(true, instance.env);
    expect(await runCli(["run", "--help"], help)).toBe(0);
    expect(stdoutText(help)).toContain("ag-cli run");
    expect(await runCli(["wait", "-h"], help)).toBe(0);
  });

  it("keeps every argument after the first -- as a literal positional (review F15)", () => {
    const parsed = parseCommandFlags(["--", "--"], { booleans: [], values: [] });
    expect(parsed.positionals).toEqual(["--"]);
    const parsed2 = parseCommandFlags(["--", "--help", "x"], { booleans: [], values: [] });
    expect(parsed2.positionals).toEqual(["--help", "x"]);
    const parsed3 = parseCommandFlags(["a", "--", "--json"], { booleans: ["json"], values: [] });
    expect(parsed3.positionals).toEqual(["a", "--json"]);
    expect(parsed3.flags.size).toBe(0);
  });

  it("only triggers help interception before the -- separator (review F15)", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const server = await startMockLanguageServer();
    openServers.push(server);
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: server.port,
      httpsPort: server.port,
      lsVersion: "1.0.0",
      csrfToken: server.csrfToken,
    });

    const ctx = context(false, instance.env);
    const code = await runCli(["run", "--bg", "--json", "--", "--help"], ctx);
    expect(code).toBe(0);
    const payload = stdoutJson<{ conversationId: string }>(ctx);
    expect(payload.conversationId).toBeDefined();
    const transcript = readFileSync(
      join(
        instance.brainDir,
        payload.conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      ),
      "utf8",
    );
    expect(transcript).toContain("--help");
  });

  it("enforces exact positional arities on every command (review F15)", async () => {
    const instance = sandbox();
    const twoTargets = context(false, instance.env);
    expect(await runCli(["get", "second", "unused-target"], twoTargets)).toBe(2);
    expect(JSON.parse(stderrText(twoTargets))).toMatchObject({ error: { kind: "invalid_usage" } });

    const readExtra = context(false, instance.env);
    expect(await runCli(["read", "a", "b"], readExtra)).toBe(2);
    const waitExtra = context(false, instance.env);
    expect(await runCli(["wait", "a", "b"], waitExtra)).toBe(2);
    const sendExtra = context(false, instance.env);
    expect(await runCli(["send", "a", "b", "c"], sendExtra)).toBe(2);
    const killExtra = context(false, instance.env);
    expect(await runCli(["kill", "a", "b"], killExtra)).toBe(2);
    const lsExtra = context(false, instance.env);
    expect(await runCli(["ls", "stray"], lsExtra)).toBe(2);
    const statusExtra = context(false, instance.env);
    expect(await runCli(["status", "stray"], statusExtra)).toBe(2);
    const eventsExtra = context(false, instance.env);
    expect(await runCli(["events", "stray"], eventsExtra)).toBe(2);
    const templatesExtra = context(false, instance.env);
    expect(await runCli(["templates", "stray"], templatesExtra)).toBe(2);
  });

  it("rejects option-like values and invalid ls statuses", async () => {
    const instance = sandbox();
    const optionLike = context(false, instance.env);
    expect(await runCli(["get", "--json", "--name"], optionLike)).toBe(2);

    const badStatus = context(false, instance.env);
    expect(await runCli(["ls", "--status", "bogus"], badStatus)).toBe(2);
  });
});

describe("runCli dispatch", () => {
  it("routes missing commands through json errors when piped", async () => {
    const instance = sandbox();
    const ctx = context(false, instance.env);
    const code = await runCli([], ctx);
    expect(code).toBe(2);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({ error: { kind: "invalid_usage" } });

    const tty = context(true, instance.env);
    expect(await runCli([], tty)).toBe(2);
    expect(stderrText(tty)).toContain("Usage");
  });

  it("prints usage and exits 0 for --help", async () => {
    const instance = sandbox();
    const ctx = context(true, instance.env);
    const code = await runCli(["--help"], ctx);
    expect(code).toBe(0);
    expect(stdoutText(ctx)).toContain("Usage");
  });

  it("rejects unknown commands with exit 2", async () => {
    const instance = sandbox();
    const ctx = context(false, instance.env);
    const code = await runCli(["frobnicate"], ctx);
    expect(code).toBe(2);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({ error: { kind: "invalid_usage" } });
  });
});

describe("status command", () => {
  it("reports a healthy daemon and readable summaries in json", async () => {
    const instance = sandbox();
    const mock = await startMockLanguageServer();
    openServers.push(mock);
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: mock.port,
      httpsPort: mock.port,
      lsVersion: "1.2.3",
      csrfToken: mock.csrfToken,
    });
    await prepareConversation(instance);

    const ctx = context(false, instance.env);
    const code = await runCli(["status", "--json"], ctx);
    expect(code).toBe(0);
    const payload = stdoutJson<{
      daemon: { healthy: boolean; pid: number; httpPort: number; problems: string[] };
      summaries: { readable: boolean; conversations: number };
      agentapi: { present: boolean; executable: boolean };
      stateDb: { present: boolean };
    }>(ctx);
    expect(payload.daemon.healthy).toBe(true);
    expect(payload.daemon.pid).toBe(process.pid);
    expect(payload.daemon.problems).toEqual([]);
    expect(payload.summaries).toEqual({ readable: true, conversations: 1 });
    expect(payload.agentapi.present).toBe(true);
    expect(payload.agentapi.executable).toBe(true);
    expect(payload.stateDb.present).toBe(false);
  });

  it("reports an unhealthy daemon without failing the command", async () => {
    const instance = sandbox();
    const ctx = context(true, instance.env);
    const code = await runCli(["status"], ctx);
    expect(code).toBe(0);
    const text = stdoutText(ctx);
    expect(text).toContain("daemon");
  });

  it("accepts the doctor alias", async () => {
    const instance = sandbox();
    const ctx = context(false, instance.env);
    const code = await runCli(["doctor", "--json"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ daemon: { healthy: boolean } }>(ctx).daemon.healthy).toBe(false);
  });

  it("reports a healthy stack in text mode", async () => {
    const instance = sandbox();
    const mock = await startMockLanguageServer();
    openServers.push(mock);
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: mock.port,
      httpsPort: mock.port,
      lsVersion: "1.2.3",
      csrfToken: mock.csrfToken,
    });
    await prepareConversation(instance);
    writeMockAgentapi(instance);

    const ctx = context(true, instance.env);
    const code = await runCli(["status"], ctx);
    expect(code).toBe(0);
    const text = stdoutText(ctx);
    expect(text).toContain("daemon: healthy");
    expect(text).toContain("agentapi: present and executable");
    expect(text).toContain("summaries: readable");
  });

  it("reports dead pids and non-executable agentapi binaries", async () => {
    const instance = sandbox();
    writeHubFile(instance, {
      pid: 999_999_999,
      httpPort: 4100,
      httpsPort: 4101,
      lsVersion: "1.0.0",
      csrfToken: "dead",
    });
    writeFileSync(instance.agentapiBin, "#!/bin/sh\nexit 0\n");
    writeFileSync(join(instance.agCliHome, "state.db"), "");

    const ctx = context(false, instance.env);
    const code = await runCli(["status", "--json"], ctx);
    expect(code).toBe(0);
    const payload = stdoutJson<{
      daemon: { healthy: boolean; problems: string[] };
      agentapi: { present: boolean; executable: boolean };
      stateDb: { present: boolean };
    }>(ctx);
    expect(payload.daemon.healthy).toBe(false);
    expect(payload.daemon.problems[0]).toContain("dead pid");
    expect(payload.agentapi).toMatchObject({ present: true, executable: false });
    expect(payload.stateDb.present).toBe(true);

    const textCtx = context(true, instance.env);
    await runCli(["status"], textCtx);
    const text = stdoutText(textCtx);
    expect(text).toContain("present but not executable");
    expect(text).toContain("state.db: present");
  });

  it("reports unreachable daemons whose pid is alive", async () => {
    const instance = sandbox();
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: 1,
      httpsPort: 1,
      lsVersion: "1.0.0",
      csrfToken: "unreachable",
    });

    const jsonCtx = context(false, instance.env);
    await runCli(["status", "--json"], jsonCtx);
    const payload = stdoutJson<{ daemon: { problems: string[] } }>(jsonCtx);
    expect(payload.daemon.problems[0]).toContain("unreachable /healthz");

    const textCtx = context(true, instance.env);
    await runCli(["status"], textCtx);
    expect(stdoutText(textCtx)).toContain("problem:");
  });
});

describe("ls command", () => {
  it("lists conversations derived from observed facts", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);

    const ctx = context(false, instance.env);
    const code = await runCli(["ls"], ctx);
    expect(code).toBe(0);
    const rows =
      stdoutJson<
        Array<{
          conversationId: string;
          status: string;
          title: string;
          turn: number;
          stepCount: number;
          shortId: string;
          name: string;
        }>
      >(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId,
      status: "done",
      title: "deps job",
      turn: 1,
      stepCount: 3,
      shortId: null,
      name: null,
    });
  });

  it("hides killed conversations unless --all is passed", async () => {
    const instance = sandbox();
    await prepareConversation(instance);
    const db = initSummariesDb(instance);
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, killed, last_modified_time) VALUES (?, ?, 1, ?)",
    ).run("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dead job", "2026-11-14T05:00:00Z");
    db.close();

    const defaultCtx = context(false, instance.env);
    await runCli(["ls"], defaultCtx);
    expect(stdoutJson<Array<{ conversationId: string }>>(defaultCtx)).toHaveLength(1);

    const allCtx = context(false, instance.env);
    await runCli(["ls", "--all"], allCtx);
    const all = stdoutJson<Array<{ conversationId: string; status: string }>>(allCtx);
    expect(all).toHaveLength(2);
    expect(
      all.find((row) => row.conversationId === "cccccccc-cccc-4ccc-8ccc-cccccccccccc")?.status,
    ).toBe("error");
  });

  it("filters by --status", async () => {
    const instance = sandbox();
    await prepareConversation(instance);

    const ctx = context(false, instance.env);
    await runCli(["ls", "--status", "working"], ctx);
    expect(stdoutJson<Array<unknown>>(ctx)).toHaveLength(0);
  });

  it("renders a tty table", async () => {
    const instance = sandbox();
    await prepareConversation(instance);

    const ctx = context(true, instance.env);
    const code = await runCli(["ls"], ctx);
    expect(code).toBe(0);
    const text = stdoutText(ctx);
    expect(text).toContain("SHORT");
    expect(text).toContain("STATUS");
    expect(text).toContain("deps job");
  });

  it("handles an empty registry cleanly", async () => {
    const instance = sandbox();
    const ctx = context(false, instance.env);
    const code = await runCli(["ls"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<Array<unknown>>(ctx)).toEqual([]);
  });

  it("parses workspace_uris into the project column and tolerates junk", async () => {
    const instance = sandbox();
    await prepareConversation(instance);
    const db = initSummariesDb(instance);
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, last_modified_time) VALUES (?, ?, ?, ?)",
    ).run(
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      null,
      JSON.stringify([42, "file:///tmp/junk-repo"]),
      "2026-11-14T06:00:00Z",
    );
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, last_modified_time) VALUES (?, ?, ?, ?)",
    ).run("ffffffff-ffff-4fff-8fff-ffffffffffff", "broken ws", "not-json", "2026-11-14T07:00:00Z");
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, last_modified_time) VALUES (?, ?, ?, ?)",
    ).run(
      "12341234-1234-4234-8234-123412341234",
      "no strings",
      JSON.stringify([42]),
      "2026-11-14T08:00:00Z",
    );
    db.prepare("INSERT INTO conversation_summaries (conversation_id, title) VALUES (?, ?)").run(
      "45454545-4545-4455-8455-454545454545",
      "no timestamp",
    );
    db.close();

    const ctx = context(false, instance.env);
    await runCli(["ls", "--all"], ctx);
    const rows =
      stdoutJson<Array<{ conversationId: string; project: string; updated: string }>>(ctx);
    expect(
      rows.find((row) => row.conversationId === "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")?.project,
    ).toBe("/tmp/junk-repo");
    expect(
      rows.find((row) => row.conversationId === "ffffffff-ffff-4fff-8fff-ffffffffffff")?.project,
    ).toBe("");
    expect(
      rows.find((row) => row.conversationId === "12341234-1234-4234-8234-123412341234")?.project,
    ).toBe("");
    expect(
      rows.find((row) => row.conversationId === "45454545-4545-4455-8455-454545454545")?.updated,
    ).toBe("");
  });
});

describe("get command", () => {
  it("returns the full observed snapshot in json", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);

    const ctx = context(false, instance.env);
    const code = await runCli(["get", conversationId.slice(0, 8), "--json"], ctx);
    expect(code).toBe(0);
    const payload = stdoutJson<{
      conversationId: string;
      status: string;
      turn: number;
      stepCount: number;
      watermarkStep: number;
      telemetry: { inputTokens: number; outputTokens: number; stepCount: number };
      artifacts: Array<{ name: string }>;
    }>(ctx);
    expect(payload.conversationId).toBe(conversationId);
    expect(payload.status).toBe("done");
    expect(payload.turn).toBe(1);
    expect(payload.telemetry.stepCount).toBe(3);
    expect(payload.watermarkStep).toBe(-1);
    expect(payload.artifacts).toEqual([]);
  });

  it("renders text output on a tty", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);
    writeFileSync(join(instance.brainDir, conversationId, "report.md"), "# r");

    const ctx = context(true, instance.env);
    const code = await runCli(["get", conversationId], ctx);
    expect(code).toBe(0);
    const text = stdoutText(ctx);
    expect(text).toContain(conversationId);
    expect(text).toContain("status:");
    expect(text).toContain("- report.md (");
  });

  it("defaults to the caller conversation", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);

    const ctx = context(false, { ...instance.env, ANTIGRAVITY_CONVERSATION_ID: conversationId });
    const code = await runCli(["get"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ conversationId: string }>(ctx).conversationId).toBe(conversationId);
  });

  it("exits 1 with a json error for unknown targets when piped", async () => {
    const instance = sandbox();
    await prepareConversation(instance);

    const ctx = context(false, instance.env);
    const code = await runCli(["get", "c99"], ctx);
    expect(code).toBe(1);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({ error: { kind: "not_found" } });
  });

  it("exits 2 with missing_target without target or caller", async () => {
    const instance = sandbox();
    const ctx = context(false, instance.env);
    const code = await runCli(["get"], ctx);
    expect(code).toBe(2);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({ error: { kind: "invalid_usage" } });
  });

  it("reports the latest error step for errored conversations", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const created = runAgentapi(instance, ["new-conversation", "explode"], {
      AG_MOCK_AGENTAPI_MODE: "error",
    });
    const errored = (JSON.parse(created.stdout) as { conversationId: string }).conversationId;

    const ctx = context(false, instance.env);
    const code = await runCli(["get", errored, "--json"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ status: string; latestError: string }>(ctx)).toMatchObject({
      status: "error",
      latestError: "mock failure",
    });
  });

  it("renders a null title and contentless errors in text mode", async () => {
    const instance = sandbox();
    const brainOnly = "15151515-1515-4151-8151-151515151515";
    const logs = join(instance.brainDir, brainOnly, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "transcript.jsonl"),
      `${JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "q" })}\n${JSON.stringify({ step_index: 1, status: "ERROR" })}\n`,
    );

    const ctx = context(true, instance.env);
    const code = await runCli(["get", brainOnly], ctx);
    expect(code).toBe(0);
    const text = stdoutText(ctx);
    expect(text).toContain("title: ");
  });
});

describe("read command", () => {
  it("prints the pure reply body when piped", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance, "summarize the diff");

    const ctx = context(false, instance.env);
    const code = await runCli(["read", conversationId], ctx);
    expect(code).toBe(0);
    expect(stdoutText(ctx)).toBe(`Mock reply for: summarize the diff\n`);
  });

  it("prints the formatted reply on a tty", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);
    writeFileSync(join(instance.brainDir, conversationId, "shot.png"), "png");

    const ctx = context(true, instance.env);
    const code = await runCli(["read", conversationId], ctx);
    expect(code).toBe(0);
    const text = stdoutText(ctx);
    expect(text).toContain("Turn 1");
    expect(text).toContain("Mock reply for: upgrade deps");
    expect(text).toContain("Artifacts (1)");
    expect(text).toContain("- shot.png");
  });

  it("returns the full json payload with --json", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);

    const ctx = context(false, instance.env);
    const code = await runCli(["read", conversationId, "--json"], ctx);
    expect(code).toBe(0);
    const payload = stdoutJson<{
      conversationId: string;
      status: string;
      turn: number;
      reply: string;
      turns: Array<{ reply: string }>;
      telemetry: { stepCount: number };
      artifacts: Array<unknown>;
    }>(ctx);
    expect(payload.conversationId).toBe(conversationId);
    expect(payload.status).toBe("done");
    expect(payload.reply).toBe("Mock reply for: upgrade deps");
    expect(payload.turns).toHaveLength(1);
    expect(payload.telemetry.stepCount).toBe(3);
  });

  it("renders step traces with --steps and limits with --lines", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);

    const fullCtx = context(true, instance.env);
    await runCli(["read", conversationId, "--steps"], fullCtx);
    const full = stdoutText(fullCtx);
    expect(full).toContain("[system] USER_INPUT upgrade deps");
    expect(full).toContain("[tool] read_file (DONE)");
    expect(full).toContain("[reply] Mock reply for: upgrade deps");

    const limitedCtx = context(true, instance.env);
    await runCli(["read", conversationId, "--steps", "--lines", "1"], limitedCtx);
    const lines = stdoutText(limitedCtx)
      .split("\n")
      .filter((line) => line.startsWith("["));
    expect(lines).toEqual(["[reply] Mock reply for: upgrade deps"]);
  });

  it("merges truncated fields with --full", async () => {
    const instance = sandbox();
    const conversationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const db = initSummariesDb(instance);
    db.prepare("INSERT INTO conversation_summaries (conversation_id, title) VALUES (?, ?)").run(
      conversationId,
      "truncated job",
    );
    db.close();
    const logs = join(instance.brainDir, conversationId, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const steps = [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "task" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "trunc…",
        truncated_fields: ["content"],
      },
    ];
    writeFileSync(
      join(logs, "transcript.jsonl"),
      `${steps.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const fullSteps = [
      steps[0] as Record<string, unknown>,
      { ...steps[1], content: "the complete reply body" },
    ];
    writeFileSync(
      join(logs, "transcript_full.jsonl"),
      `${fullSteps.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const mergedCtx = context(false, instance.env);
    await runCli(["read", conversationId, "--json", "--full"], mergedCtx);
    expect(stdoutJson<{ reply: string }>(mergedCtx).reply).toBe("the complete reply body");

    const plainCtx = context(false, instance.env);
    await runCli(["read", conversationId, "--json"], plainCtx);
    expect(stdoutJson<{ reply: string }>(plainCtx).reply).toBe("trunc…");
  });

  it("reads artifacts by name", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);
    const brain = join(instance.brainDir, conversationId);
    writeFileSync(join(brain, "report.md"), "# findings\n");

    const ctx = context(false, instance.env);
    const code = await runCli(["read", conversationId, "--artifact", "report.md"], ctx);
    expect(code).toBe(0);
    expect(stdoutText(ctx)).toBe("# findings\n");

    const missingCtx = context(false, instance.env);
    const missingCode = await runCli(["read", conversationId, "--artifact", "nope.md"], missingCtx);
    expect(missingCode).toBe(1);
    expect(JSON.parse(stderrText(missingCtx))).toMatchObject({ error: { kind: "not_found" } });
  });

  it("rejects artifact paths that escape the conversation brain dir", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);
    writeFileSync(join(instance.root, "outside.txt"), "secret");

    const traversal = context(false, instance.env);
    const code = await runCli(
      ["read", conversationId, "--artifact", "../../../outside.txt"],
      traversal,
    );
    expect(code).toBe(2);
    expect(JSON.parse(stderrText(traversal))).toMatchObject({ error: { kind: "invalid_usage" } });

    const linkPath = join(instance.brainDir, conversationId, "escape.txt");
    symlinkSync(join(instance.root, "outside.txt"), linkPath);
    const linked = context(false, instance.env);
    expect(await runCli(["read", conversationId, "--artifact", "escape.txt"], linked)).toBe(2);
  });

  it("rejects artifact reads when the conversation dir itself escapes the brain root (review F9)", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);
    const outside = join(instance.root, "outside-brain");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "SYNTHETIC-OUTSIDE");
    rmSync(join(instance.brainDir, conversationId), { recursive: true, force: true });
    symlinkSync(outside, join(instance.brainDir, conversationId));

    const ctx = context(false, instance.env);
    const code = await runCli(["read", conversationId, "--artifact", "secret.txt"], ctx);
    expect(code).toBe(2);
    expect(JSON.parse(stderrText(ctx))).toMatchObject({ error: { kind: "invalid_usage" } });
  });

  it("lists artifacts in the json payload", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);
    writeFileSync(join(instance.brainDir, conversationId, "shot.png"), "png");
    mkdirSync(join(instance.brainDir, conversationId, "nested"), { recursive: true });

    const ctx = context(false, instance.env);
    await runCli(["read", conversationId, "--json"], ctx);
    const payload = stdoutJson<{ artifacts: Array<{ name: string; bytes: number }> }>(ctx);
    expect(payload.artifacts.map((artifact) => artifact.name)).toEqual(["shot.png"]);
    expect(payload.artifacts[0]?.bytes).toBe(3);
  });

  it("renders exotic step shapes in --steps output", async () => {
    const instance = sandbox();
    const conversationId = "abababab-abab-4bab-8bab-abababababab";
    const db = initSummariesDb(instance);
    db.prepare("INSERT INTO conversation_summaries (conversation_id, title) VALUES (?, ?)").run(
      conversationId,
      "exotic",
    );
    db.close();
    const logs = join(instance.brainDir, conversationId, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const steps = [
      { step_index: 0, type: "SYSTEM_MESSAGE", status: "DONE", content: "queued" },
      { step_index: 1, type: "GENERIC", status: "DONE", thinking: "deep thought" },
      { step_index: 2, type: "GENERIC", status: "DONE", content: "plain body" },
      {
        step_index: 3,
        type: "GENERIC",
        status: "DONE",
        tool_calls: [{ status: "RUNNING" }, { name: "silent" }],
      },
      {
        step_index: 5,
        type: "GENERIC",
        status: "DONE",
        thinking: "with tools",
        tool_calls: [{ name: "grep", status: "DONE" }],
      },
      { step_index: 4, type: "PLANNER_RESPONSE", status: "DONE", content: "final" },
      { step_index: 6, type: "SYSTEM_MESSAGE", status: "DONE" },
      { step_index: 7, status: "DONE", content: "typeless body" },
      { step_index: 8, type: "GENERIC", status: "DONE", thinking: "" },
    ];
    writeFileSync(
      join(logs, "transcript.jsonl"),
      `${steps.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const ctx = context(true, instance.env);
    const code = await runCli(["read", conversationId, "--steps"], ctx);
    expect(code).toBe(0);
    const lines = stdoutText(ctx)
      .split("\n")
      .filter((line) => line.startsWith("["));
    expect(lines).toEqual([
      "[system] SYSTEM_MESSAGE queued",
      "[think] deep thought",
      "[think] plain body",
      "[tool]  (RUNNING)",
      "[tool] silent",
      "[think] with tools",
      "[tool] grep (DONE)",
      "[reply] final",
      "[system] SYSTEM_MESSAGE",
      "[think] typeless body",
      "[think]",
    ]);
  });

  it("rejects non-numeric --turns and --lines values", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance);

    const turnsCtx = context(false, instance.env);
    const turnsCode = await runCli(["read", conversationId, "--turns", "zero"], turnsCtx);
    expect(turnsCode).toBe(2);
    expect(JSON.parse(stderrText(turnsCtx))).toMatchObject({ error: { kind: "invalid_usage" } });

    const linesCtx = context(false, instance.env);
    const linesCode = await runCli(["read", conversationId, "--steps", "--lines", "0"], linesCtx);
    expect(linesCode).toBe(2);
  });

  it("survives --full without a transcript_full.jsonl", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance, "no full file");

    const ctx = context(false, instance.env);
    const code = await runCli(["read", conversationId, "--json", "--full"], ctx);
    expect(code).toBe(0);
    expect(stdoutJson<{ reply: string }>(ctx).reply).toBe("Mock reply for: no full file");
  });

  it("limits turns with --turns", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance, "turn one");
    runAgentapi(instance, ["send-message", conversationId, "turn two"]);

    const ctx = context(false, instance.env);
    await runCli(["read", conversationId, "--json"], ctx);
    const payload = stdoutJson<{ turn: number; turns: Array<{ reply: string }> }>(ctx);
    expect(payload.turn).toBe(2);
    expect(payload.turns).toHaveLength(1);
    expect(payload.turns[0]?.reply).toBe("Mock reply for: turn two");
  });

  it("reports total turns while selecting recent ones (review F16)", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance, "turn one");
    runAgentapi(instance, ["send-message", conversationId, "turn two"]);

    const ctx = context(false, instance.env);
    await runCli(["read", conversationId, "--json", "--turns", "2"], ctx);
    const payload = stdoutJson<{
      turn: number;
      turns: Array<{ turn: number; reply: string }>;
    }>(ctx);
    expect(payload.turn).toBe(2);
    expect(payload.turns).toHaveLength(2);
    expect(payload.turns[0]?.reply).toBe("Mock reply for: turn one");
    expect(payload.turns[1]?.reply).toBe("Mock reply for: turn two");
  });

  it("merges full transcripts before segmenting turns so replies are untruncated (review F16)", async () => {
    const instance = sandbox();
    const conversationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const db = initSummariesDb(instance);
    db.prepare("INSERT INTO conversation_summaries (conversation_id, title) VALUES (?, ?)").run(
      conversationId,
      "two turns",
    );
    db.close();
    const logs = join(instance.brainDir, conversationId, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const turnOne = [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "first" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "TRUNC1",
        truncated_fields: ["content"],
      },
    ];
    const turnTwo = [
      { step_index: 2, type: "USER_INPUT", status: "DONE", content: "second" },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "TRUNC2",
        truncated_fields: ["content"],
      },
    ];
    writeFileSync(
      join(logs, "transcript.jsonl"),
      `${[...turnOne, ...turnTwo].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    writeFileSync(
      join(logs, "transcript_full.jsonl"),
      `${[...turnOne, ...turnTwo]
        .map((entry, index) =>
          JSON.stringify({
            ...entry,
            content:
              entry.content === "TRUNC1" || entry.content === "TRUNC2"
                ? `FULL${index}`
                : entry.content,
          }),
        )
        .join("\n")}\n`,
    );

    const jsonCtx = context(false, instance.env);
    await runCli(["read", conversationId, "--json", "--full", "--turns", "2"], jsonCtx);
    const payload = stdoutJson<{
      turn: number;
      reply: string;
      turns: Array<{ turn: number; reply: string }>;
    }>(jsonCtx);
    expect(payload.turn).toBe(2);
    expect(payload.reply).toBe("FULL3");
    expect(payload.turns.map((turn) => turn.reply)).toEqual(["FULL1", "FULL3"]);

    const textCtx = context(false, instance.env);
    await runCli(["read", conversationId, "--full", "--turns", "2"], textCtx);
    const text = stdoutText(textCtx);
    expect(text).toContain("FULL1");
    expect(text).toContain("FULL3");
  });

  it("answers json errors on stderr when tty reads fail", async () => {
    const instance = sandbox();
    const ctx = context(true, instance.env);
    const code = await runCli(["read", "nope-target-!!"], ctx);
    expect(code).toBe(2);
    expect(stderrText(ctx)).toContain("ag-cli:");
  });

  it("prints a uuid header for unmanaged conversations on a tty", async () => {
    const instance = sandbox();
    const brainOnly = "14141414-1414-4141-8141-141414141414";
    const logs = join(instance.brainDir, brainOnly, ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "transcript.jsonl"),
      `${JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "q" })}\n${JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "unmanaged reply" })}\n`,
    );

    const ctx = context(true, instance.env);
    const code = await runCli(["read", brainOnly], ctx);
    expect(code).toBe(0);
    const text = stdoutText(ctx);
    expect(text).toContain("# 14141414 \u00b7 Turn 1 \u00b7 idle");
    expect(text).toContain("unmanaged reply");
  });

  it("includes the steps array in json output with --steps", async () => {
    const instance = sandbox();
    const conversationId = await prepareConversation(instance, "trace me");

    const ctx = context(false, instance.env);
    await runCli(["read", conversationId, "--json", "--steps"], ctx);
    const payload = stdoutJson<{ steps: Array<{ type: string }> }>(ctx);
    expect(payload.steps.map((step) => step.type)).toEqual([
      "USER_INPUT",
      "GENERIC",
      "PLANNER_RESPONSE",
    ]);
  });

  it("reports empty replies for turns without a planner response", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const created = runAgentapi(instance, ["new-conversation", "stuck"], {
      AG_MOCK_AGENTAPI_MODE: "blocked",
    });
    const blocked = (JSON.parse(created.stdout) as { conversationId: string }).conversationId;

    const ctx = context(false, instance.env);
    const code = await runCli(["read", blocked, "--json"], ctx);
    expect(code).toBe(0);
    const payload = stdoutJson<{ status: string; reply: string; turns: Array<{ reply: string }> }>(
      ctx,
    );
    expect(payload.status).toBe("blocked");
    expect(payload.reply).toBe("");
    expect(payload.turns[0]?.reply).toBe("");
  });
});
