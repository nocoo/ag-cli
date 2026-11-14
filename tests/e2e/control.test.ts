import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSandbox,
  initSummariesDb,
  isolatedSubprocessEnv,
  type MockLanguageServer,
  readTranscript,
  type Sandbox,
  startMockLanguageServer,
  writeHubFile,
  writeMockAgentapi,
} from "../helpers/sandbox";

const cliBin = join(process.cwd(), "dist", "index.js");
const execFileAsync = promisify(execFile);

let instance: Sandbox;
let server: MockLanguageServer;

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("node", [cliBin, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...isolatedSubprocessEnv(), ...instance.env, ...env },
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message: string };
    if (typeof failure.code === "number") {
      return { status: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
    throw new Error(failure.message);
  }
}

beforeAll(async () => {
  instance = createSandbox("nullg-e2e-control");
  initSummariesDb(instance);
  writeMockAgentapi(instance);
  server = await startMockLanguageServer({ responses: { CancelCascadeInvocation: {} } });
  writeHubFile(instance, {
    pid: process.pid,
    httpPort: server.port,
    httpsPort: server.port,
    lsVersion: "e2e",
    csrfToken: server.csrfToken,
  });
});

afterEach(() => {
  server.rpcCalls.length = 0;
});

afterAll(async () => {
  await server.close();
  instance.cleanup();
});

describe("control e2e against dist/index.js", () => {
  it("runs a background conversation end to end", async () => {
    const result = await runCli([
      "run",
      "--bg",
      "--json",
      "--name",
      "e2e-worker",
      "--label",
      "task=e2e",
      "verify the full stack",
    ]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      shortId: number;
      conversationId: string;
      name: string;
      reused: boolean;
      watermarkStep: number;
      status: string;
    };
    expect(payload).toMatchObject({
      shortId: "c1",
      name: "e2e-worker",
      reused: false,
      watermarkStep: 0,
      status: "done",
    });

    const get = await runCli(["get", "e2e-worker", "--json"]);
    expect(get.status).toBe(0);
    expect(JSON.parse(get.stdout)).toMatchObject({
      conversationId: payload.conversationId,
      labels: { task: "e2e" },
      status: "done",
    });
  });

  it("reuses a named worker and advances the watermark", async () => {
    const first = await runCli(["ls", "--json"]);
    const conversationId = (JSON.parse(first.stdout) as Array<{ conversationId: string }>)[0]
      ?.conversationId;
    expect(conversationId).toBeDefined();

    const reuse = await runCli([
      "run",
      "--bg",
      "--json",
      "--reuse",
      "--name",
      "e2e-worker",
      "second round",
    ]);
    expect(reuse.status).toBe(0);
    expect(JSON.parse(reuse.stdout)).toMatchObject({
      conversationId,
      reused: true,
      watermarkStep: 3,
    });
    expect(readTranscript(instance, conversationId as string)).toHaveLength(6);
  });

  it("rejects name conflicts and invalid usage over the binary", async () => {
    const conflict = await runCli(["run", "--bg", "--json", "--name", "e2e-worker", "again"]);
    expect(conflict.status).toBe(1);
    expect(JSON.parse(conflict.stderr)).toMatchObject({ error: { kind: "name_conflict" } });

    const noReuseName = await runCli(["run", "--bg", "--json", "--reuse", "task"]);
    expect(noReuseName.status).toBe(2);

    const template = await runCli(["run", "--bg", "--json", "some-template", "prompt"]);
    expect(template.status).toBe(1);
    expect(JSON.parse(template.stderr)).toMatchObject({ error: { kind: "not_found" } });
  });

  it("sends messages with preconditions and watermark tracking", async () => {
    const ok = await runCli(["send", "--if", "done", "e2e-worker", "third round"]);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ shortId: "c1", watermarkStep: 6, queued: false });

    const mismatch = await runCli(["send", "--if", "idle", "e2e-worker", "nope"]);
    expect(mismatch.status).toBe(3);
    expect(JSON.parse(mismatch.stderr)).toMatchObject({ error: { kind: "precondition_failed" } });
  });

  it("waits for a turn to settle with send --wait", async () => {
    const result = await runCli(["send", "--wait", "--json", "e2e-worker", "fourth round"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ reason: "done", status: "done" });
  });

  it("labels, interrupts, kills and removes conversations", async () => {
    const label = await runCli(["label", "e2e-worker", "env=prod"]);
    expect(label.status).toBe(0);
    expect(JSON.parse(label.stdout)).toMatchObject({ labels: { env: "prod" } });

    const interrupt = await runCli(["interrupt", "e2e-worker", "--json"]);
    expect(interrupt.status).toBe(0);
    expect(server.rpcCalls.find((call) => call.method === "CancelCascadeInvocation")).toBeDefined();

    const kill = await runCli(["kill", "e2e-worker", "--json"]);
    expect(kill.status).toBe(0);
    expect(JSON.parse(kill.stdout)).toMatchObject({ terminated: true });

    const ls = await runCli(["ls", "--json"]);
    expect(JSON.parse(ls.stdout)).toEqual([]);

    const rm = await runCli(["rm", "c1", "--json"]);
    expect(rm.status).toBe(0);
    expect(JSON.parse(rm.stdout)).toMatchObject({ removed: true, purgedBrain: false });
  });

  it("purges brain files only with --purge-brain", async () => {
    const run = await runCli(["run", "--bg", "--json", "--name", "purge-target", "task"]);
    const conversationId = (JSON.parse(run.stdout) as { conversationId: string }).conversationId;
    expect(existsSync(join(instance.brainDir, conversationId))).toBe(true);

    const rm = await runCli(["rm", "--purge-brain", "purge-target", "--json"]);
    expect(rm.status).toBe(0);
    expect(JSON.parse(rm.stdout)).toMatchObject({ removed: true, purgedBrain: true });
    expect(existsSync(join(instance.brainDir, conversationId))).toBe(false);
  });

  it("returns exit 124 on wait timeouts", async () => {
    const run = await runCli(["run", "--bg", "--json", "slow start"], {
      AG_MOCK_AGENTAPI_MODE: "stuck",
    });
    expect(run.status).toBe(0);
    const conversationId = (JSON.parse(run.stdout) as { conversationId: string }).conversationId;

    const wait = await runCli(["send", "--wait", "--timeout", "1", conversationId, "nudge"], {
      AG_MOCK_AGENTAPI_MODE: "stuck",
    });
    expect(wait.status).toBe(124);
    expect(JSON.parse(wait.stdout)).toMatchObject({ reason: "timeout", timedOut: true });
  }, 15000);
});
