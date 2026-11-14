import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSandbox,
  initSummariesDb,
  isolatedSubprocessEnv,
  runAgentapi,
  type Sandbox,
  startMockLanguageServer,
  writeHubFile,
  writeMockAgentapi,
} from "../helpers/sandbox";

const cliBin = join(process.cwd(), "dist", "index.js");
const execFileAsync = promisify(execFile);

let instance: Sandbox;
let conversationId: string;
const servers: Array<{ close(): Promise<void> }> = [];

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("node", [cliBin, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...isolatedSubprocessEnv(), ...instance.env, ...env },
    });
    return {
      status: 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message: string };
    if (typeof failure.code === "number") {
      return { status: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
    throw new Error(failure.message);
  }
}

beforeAll(() => {
  instance = createSandbox("nullg-e2e-readonly");
  initSummariesDb(instance);
  writeMockAgentapi(instance);
  const created = runAgentapi(instance, [
    "new-conversation",
    "--title",
    "e2e job",
    "--message",
    "verify flows",
  ]);
  expect(created.status).toBe(0);
  conversationId = (JSON.parse(created.stdout) as { conversationId: string }).conversationId;
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

afterAll(() => {
  instance.cleanup();
});

describe("read-only e2e against dist/index.js", () => {
  it("prints usage with exit 0 for --help", async () => {
    const result = await runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage");
  });

  it("reports daemon health in status --json", async () => {
    const mock = await startMockLanguageServer();
    servers.push(mock);
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: mock.port,
      httpsPort: mock.port,
      lsVersion: "e2e",
      csrfToken: mock.csrfToken,
    });

    const result = await runCli(["status", "--json"]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { daemon: { healthy: boolean; pid: number } };
    expect(payload.daemon.healthy).toBe(true);
    expect(payload.daemon.pid).toBe(process.pid);
  });

  it("lists the conversation with derived status done", async () => {
    const result = await runCli(["ls", "--json"]);
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as Array<{
      conversationId: string;
      status: string;
      title: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId,
      status: "done",
      title: "e2e job",
    });
  });

  it("gets a conversation by uuid prefix", async () => {
    const result = await runCli(["get", conversationId.slice(0, 8), "--json"]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { conversationId: string; status: string };
    expect(payload.conversationId).toBe(conversationId);
    expect(payload.status).toBe("done");
  });

  it("reads the pure reply body when piped", async () => {
    const result = await runCli(["read", conversationId]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Mock reply for: verify flows\n");
  });

  it("defaults read to the caller conversation from the environment", async () => {
    const result = await runCli(["read"], { ANTIGRAVITY_CONVERSATION_ID: conversationId });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Mock reply for: verify flows\n");
  });

  it("prints json errors to stderr with exit 1 for unknown targets", async () => {
    const result = await runCli(["get", "c99"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { kind: "not_found" } });
  });

  it("exits 2 for missing targets without a caller", async () => {
    const result = await runCli(["get"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { kind: "invalid_usage" } });
  });

  it("exits 2 for unknown commands", async () => {
    const result = await runCli(["warp"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { kind: "invalid_usage" } });
  });
});
