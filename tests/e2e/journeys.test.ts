import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSandbox,
  initSummariesDb,
  type MockLanguageServer,
  readTranscript,
  type Sandbox,
  startMockLanguageServer,
  writeHubFile,
  writeMockAgentapi,
} from "../helpers/sandbox";

const execFileAsync = promisify(execFile);
const cliBin = join(process.cwd(), "dist", "index.js");
const outsideCwd = mkdtempSync(join(tmpdir(), "ag-cli-journey-"));

let instance: Sandbox;
let server: MockLanguageServer;

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("node", [cliBin, ...args], {
      encoding: "utf8",
      cwd: outsideCwd,
      env: {
        ...process.env,
        HC_TERMINAL_ID: "",
        AG_CLI_CALLER_ID: "",
        ANTIGRAVITY_CONVERSATION_ID: "",
        ...instance.env,
        ...env,
      },
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
  instance = createSandbox("ag-cli-e2e-journey");
  initSummariesDb(instance);
  writeMockAgentapi(instance);
  server = await startMockLanguageServer({ responses: { CancelCascadeInvocation: {} } });
  writeHubFile(instance, {
    pid: process.pid,
    httpPort: server.port,
    httpsPort: server.port,
    lsVersion: "journey",
    csrfToken: server.csrfToken,
  });
  mkdirSync(join(instance.configDir, "templates"), { recursive: true });
  writeFileSync(
    join(instance.configDir, "templates", "browser-verifier.md"),
    "---\nname: browser-verifier\ndescription: Run UI verification\nmodel: gemini-3.8-flash-medium\nprofile: verifier\ncwd: /tmp/verify\n---\nYou are a dedicated browser QA verifier.\nDo not modify repository source code.",
  );
});

afterAll(async () => {
  await server.close();
  instance.cleanup();
});

describe("full user journeys against the built cli from an unrelated cwd", () => {
  it("serves the skill manual, schema and template catalog", async () => {
    const skill = await runCli(["--skill"]);
    expect(skill.status).toBe(0);
    expect(skill.stdout).toContain("# ag-cli manual");

    const schema = await runCli(["schema"]);
    expect(schema.status).toBe(0);
    expect(JSON.parse(schema.stdout)).toMatchObject({ title: "ag-cli" });

    const templates = await runCli(["templates", "--json"]);
    expect(templates.status).toBe(0);
    expect(JSON.parse(templates.stdout)).toEqual([
      {
        name: "browser-verifier",
        description: "Run UI verification",
        model: "gemini-3.8-flash-medium",
        profile: "verifier",
        cwd: "/tmp/verify",
      },
    ]);
  });

  it("runs the delegate-wait-read journey with a template", async () => {
    const dispatched = await runCli([
      "run",
      "--bg",
      "--json",
      "--name",
      "ui-check",
      "--label",
      "task=auth",
      "browser-verifier",
      "Verify login flow on http://localhost:3000",
    ]);
    expect(dispatched.status).toBe(0);
    const payload = JSON.parse(dispatched.stdout) as {
      conversationId: string;
      model: string;
      cwd: string;
      watermarkStep: number;
    };
    expect(payload).toMatchObject({
      model: "gemini-3.8-flash-medium",
      cwd: "/tmp/verify",
      watermarkStep: 0,
    });

    const inbound = String(readTranscript(instance, payload.conversationId)[0]?.content);
    expect(inbound).toContain("You are a dedicated browser QA verifier.");
    expect(inbound).toContain("Verify login flow on http://localhost:3000");

    const waited = await runCli(["wait", "ui-check", "--json"]);
    expect(waited.status).toBe(0);
    expect(JSON.parse(waited.stdout)).toMatchObject({ reason: "done" });

    const read = await runCli(["read", "ui-check"]);
    expect(read.status).toBe(0);
    expect(read.stdout).toContain("Mock reply for: <ag-cli cwd=");
    expect(read.stdout).toContain("You are a dedicated browser QA verifier.");
    expect(read.stdout).toContain("Verify login flow on http://localhost:3000");
  });

  it("supports the follow-up send, labels, ls and cleanup journey", async () => {
    const sent = await runCli(["send", "--wait", "--json", "ui-check", "Now check dark mode too"]);
    expect(sent.status).toBe(0);
    expect(JSON.parse(sent.stdout)).toMatchObject({ reason: "done", watermarkStep: 3 });

    const labeled = await runCli(["label", "ui-check", "env=prod"]);
    expect(labeled.status).toBe(0);

    const listed = await runCli(["ls", "--label", "task=auth", "--json"]);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject([
      { name: "ui-check", labels: { task: "auth", env: "prod" }, status: "done" },
    ]);

    const killed = await runCli(["kill", "ui-check", "--json"]);
    expect(killed.status).toBe(0);
    expect(JSON.parse(killed.stdout)).toMatchObject({ terminated: true });

    const removed = await runCli(["rm", "c1", "--json"]);
    expect(removed.status).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ removed: true, purgedBrain: false });
  });

  it("reports daemon health and json errors end to end", async () => {
    const status = await runCli(["status", "--json"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).daemon).toMatchObject({ healthy: true });

    const missing = await runCli(["get", "c404"]);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stderr)).toMatchObject({ error: { kind: "not_found" } });

    const usage = await runCli(["warp"]);
    expect(usage.status).toBe(2);
    expect(JSON.parse(usage.stderr)).toMatchObject({ error: { kind: "invalid_usage" } });
  });
});
