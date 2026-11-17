import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSandbox,
  initSummariesDb,
  isolatedSubprocessEnv,
  runAgentapi,
  type Sandbox,
  writeMockAgentapi,
} from "../helpers/sandbox";

const cliBin = join(process.cwd(), "dist", "index.js");

let instance: Sandbox;
let conversationId: string;

interface CliSpawn {
  code: number | null;
  stdout: string;
  stderr: string;
}

function spawnCli(args: string[], killAfterMs?: number): Promise<CliSpawn> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliBin, ...args], {
      env: { ...process.env, ...isolatedSubprocessEnv(), ...instance.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    if (killAfterMs !== undefined) {
      setTimeout(() => {
        child.kill("SIGTERM");
      }, killAfterMs);
    }
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.on("error", reject);
  });
}

beforeAll(() => {
  instance = createSandbox("ag-cli-e2e-wait");
  initSummariesDb(instance);
  writeMockAgentapi(instance);
  const created = runAgentapi(instance, ["new-conversation", "seed"]);
  conversationId = (JSON.parse(created.stdout) as { conversationId: string }).conversationId;
});

afterAll(() => {
  instance.cleanup();
});

describe("wait and events e2e against dist/index.js", () => {
  it("waits for a settled conversation with json output", async () => {
    const result = await spawnCli(["wait", conversationId, "--json"]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as { reason: string; target: { status: string } };
    expect(payload).toMatchObject({ reason: "done", target: { status: "done" } });
  });

  it("exits 124 on wait timeouts", async () => {
    const stuck = runAgentapi(instance, ["new-conversation", "slow"], {
      AG_MOCK_AGENTAPI_MODE: "stuck",
    });
    const stuckId = (JSON.parse(stuck.stdout) as { conversationId: string }).conversationId;
    const result = await spawnCli(["wait", "--timeout", "1", stuckId, "--json"]);
    expect(result.code).toBe(124);
    expect(JSON.parse(result.stdout).reason).toBe("timeout");
  }, 10000);

  it("streams NDJSON events and terminates cleanly on SIGTERM", async () => {
    const result = await spawnCli(
      ["events", "--target", conversationId, "--heartbeat-ms", "120"],
      900,
    );
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const events = lines.map((line) => JSON.parse(line) as { type: string });
    expect(events.some((event) => event.type === "heartbeat")).toBe(true);
    expect(
      events.every((event) =>
        ["created", "status", "step", "turn", "artifact", "heartbeat"].includes(event.type),
      ),
    ).toBe(true);

    const eventsPromise = spawnCli(
      ["events", "--target", conversationId, "--heartbeat-ms", "5000"],
      2500,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    runAgentapi(instance, ["send-message", conversationId, "trigger events"]);
    const after = await eventsPromise;
    const afterEvents = after.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type: string; stepIndex?: number });
    expect(afterEvents.some((event) => event.type === "step" && event.stepIndex === 3)).toBe(true);
  }, 20000);
});
