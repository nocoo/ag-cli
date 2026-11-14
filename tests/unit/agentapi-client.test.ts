import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentApiClient } from "../../src/infra/agentapi-client";
import { openSummariesReader } from "../../src/infra/summaries-reader";
import type { AgCliError } from "../../src/types/protocol";
import {
  createSandbox,
  initSummariesDb,
  type MockLanguageServer,
  type Sandbox,
  startMockLanguageServer,
  writeHubFile,
  writeMockAgentapi,
} from "../helpers/sandbox";

const active: Sandbox[] = [];
const servers: MockLanguageServer[] = [];

function sandbox(): Sandbox {
  const created = createSandbox("ag-cli-unit-agentapi");
  active.push(created);
  return created;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

async function connectedClient(
  instance: Sandbox,
  options: {
    responses?: Record<string, unknown>;
    statusCodes?: Record<string, number>;
    projectId?: string;
  } = {},
): Promise<AgentApiClient> {
  writeMockAgentapi(instance);
  const mock = await startMockLanguageServer({
    responses: options.responses,
    statusCodes: options.statusCodes,
  });
  servers.push(mock);
  writeHubFile(instance, {
    pid: process.pid,
    httpPort: mock.port,
    httpsPort: mock.port,
    lsVersion: "1.0.0",
    csrfToken: mock.csrfToken,
  });
  return AgentApiClient.connect({
    antigravityDir: instance.antigravityDir,
    agentapiBin: instance.agentapiBin,
    projectId: options.projectId,
  });
}

describe("AgentApiClient.connect", () => {
  it("fails with daemon_unavailable without a healthy daemon", async () => {
    const instance = sandbox();
    writeMockAgentapi(instance);
    try {
      await AgentApiClient.connect({
        antigravityDir: instance.antigravityDir,
        agentapiBin: instance.agentapiBin,
      });
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("daemon_unavailable");
      expect((error as AgCliError).exitCode).toBe(4);
    }
  });

  it("fails with daemon_unavailable when the agentapi binary is not executable", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    const mock = await startMockLanguageServer();
    servers.push(mock);
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: mock.port,
      httpsPort: mock.port,
      lsVersion: "1.0.0",
      csrfToken: mock.csrfToken,
    });

    try {
      await AgentApiClient.connect({
        antigravityDir: instance.antigravityDir,
        agentapiBin: instance.agentapiBin,
      });
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("daemon_unavailable");
      expect((error as AgCliError).message).toContain("agentapi");
    }
  });
});

describe("agentapi subprocess wrappers", () => {
  it("newConversation injects LS address, CSRF token and optional project id", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const client = await connectedClient(instance, { projectId: "proj-77" });

    const before = process.env.ANTIGRAVITY_LS_ADDRESS;
    const created = await client.newConversation({
      message: "upgrade deps",
      title: "deps job",
      profile: "verifier",
    });
    expect(typeof created.conversationId).toBe("string");
    expect(created.conversationId.length).toBe(36);
    expect(process.env.ANTIGRAVITY_LS_ADDRESS).toBe(before);

    const reader = openSummariesReader(instance.summariesDbPath);
    const row = reader?.getConversation(created.conversationId);
    reader?.close();
    const env = JSON.parse(row?.workspace_uris ?? "{}") as {
      ls: string | null;
      csrf: string | null;
      project: string | null;
    };
    const server = servers[0];
    expect(env).toEqual({
      ls: `127.0.0.1:${server?.port}`,
      csrf: server?.csrfToken,
      project: "proj-77",
    });
  });

  it("passes --model and per-call project ids to agentapi", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const client = await connectedClient(instance);

    await client.newConversation({ message: "modelled", model: "pro", projectId: "proj-call" });
    const callsPath = join(instance.root, "mock-agentapi-calls.jsonl");
    const calls = readFileSync(callsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; project: string | null });
    const call = calls.find((entry) => entry.args.includes("--model"));
    expect(call?.args).toEqual(expect.arrayContaining(["--model", "pro"]));
    expect(call?.project).toBe("proj-call");
  });

  it("decodes file uris when matching project folders", async () => {
    const instance = sandbox();
    const client = await connectedClient(instance, {
      responses: {
        ListProjects: {
          projects: [{ projectId: "proj-space", folderUri: "file:///tmp/a%20b" }],
        },
      },
    });
    expect(await client.resolveProjectIdForCwd("/tmp/a b")).toBe("proj-space");
  });

  it("sendMessage and getConversationMetadata round-trip", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const client = await connectedClient(instance);

    const created = await client.newConversation({ message: "first" });
    const sent = await client.sendMessage(created.conversationId, "second turn", {
      title: "turn 2",
    });
    expect(sent.conversationId).toBe(created.conversationId);
    expect(typeof sent.stepIndex).toBe("number");

    const metadata = await client.getConversationMetadata(created.conversationId);
    expect(metadata).toMatchObject({
      conversation_id: created.conversationId,
      status: "CASCADE_RUN_STATUS_IDLE",
    });
  });

  it("surfaces agentapi failures as runtime errors", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const client = await connectedClient(instance);

    try {
      await client.sendMessage("99999999-9999-4999-8999-999999999999", "ghost");
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("runtime_error");
      expect((error as AgCliError).message).toContain("not_found");
    }
  });

  it("rejects non-JSON agentapi output", async () => {
    const instance = sandbox();
    const client = await connectedClient(instance);
    writeFileSync(instance.agentapiBin, "#!/usr/bin/env node\nprocess.stdout.write('garbage');\n", {
      mode: 0o755,
    });

    try {
      await client.newConversation({ message: "x" });
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("runtime_error");
      expect((error as AgCliError).message).toContain("non-JSON");
    }
  });

  it("rejects empty agentapi payloads and failing garbage output", async () => {
    const instance = sandbox();
    const client = await connectedClient(instance);

    writeFileSync(instance.agentapiBin, "#!/usr/bin/env node\nprocess.stdout.write('{}');\n", {
      mode: 0o755,
    });
    try {
      await client.newConversation({ message: "x" });
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("runtime_error");
      expect((error as AgCliError).message).toContain("no conversationId");
    }

    writeFileSync(
      instance.agentapiBin,
      "#!/usr/bin/env node\nprocess.stdout.write('garbage'); process.exit(1);\n",
      { mode: 0o755 },
    );
    try {
      await client.newConversation({ message: "x" });
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("runtime_error");
      expect((error as AgCliError).message).toContain("garbage");
    }
  });

  it("filters non-string entries from the inherited environment", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const mock = await startMockLanguageServer();
    servers.push(mock);
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: mock.port,
      httpsPort: mock.port,
      lsVersion: "1.0.0",
      csrfToken: mock.csrfToken,
    });
    const client = await AgentApiClient.connect({
      antigravityDir: instance.antigravityDir,
      agentapiBin: instance.agentapiBin,
      baseEnv: { ...process.env, AG_CLI_JUNK: 42 as unknown as string },
    });
    const created = await client.newConversation({ message: "env check" });
    expect(created.conversationId.length).toBe(36);
  });

  it("tolerates sendMessage payloads without a step index", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const client = await connectedClient(instance);
    writeFileSync(
      instance.agentapiBin,
      "#!/usr/bin/env node\nprocess.stdout.write('{\"ok\":true}');\n",
      {
        mode: 0o755,
      },
    );
    const sent = await client.sendMessage("11111111-1111-4111-8111-111111111111", "x");
    expect(sent).toEqual({ conversationId: "11111111-1111-4111-8111-111111111111" });
  });

  it("fails clearly when the agentapi binary exits silently", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const client = await connectedClient(instance);
    writeFileSync(instance.agentapiBin, "#!/usr/bin/env node\nprocess.exit(1);\n", {
      mode: 0o755,
    });
    try {
      await client.sendMessage("11111111-1111-4111-8111-111111111111", "x");
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("runtime_error");
      expect((error as AgCliError).message).not.toContain("undefined");
    }
  });

  it("rejects newConversation without title or profile flags", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const client = await connectedClient(instance);
    const created = await client.newConversation({ message: "bare" });
    expect(created.conversationId.length).toBe(36);
  });

  it("fails clearly when the language server disappears mid-session", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const client = await connectedClient(instance);
    for (const server of servers.splice(0)) {
      await server.close();
    }
    try {
      await client.listProjects();
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("runtime_error");
      expect((error as AgCliError).message).toContain("request failed");
    }
  });

  it("readProject tolerates a missing project payload", async () => {
    const instance = sandbox();
    const client = await connectedClient(instance, {
      responses: { ReadProject: {} },
    });
    expect(await client.readProject("ghost")).toBeNull();
  });
});

describe("Connect RPC helpers", () => {
  it("rejects an upstream conversation id that is not a uuid with runtime_error (review F9)", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    const client = await connectedClient(instance);
    writeFileSync(
      instance.agentapiBin,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({conversationId: "../../victim"}));\n',
      { mode: 0o755 },
    );
    try {
      await client.newConversation({ message: "synthetic" });
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("runtime_error");
      expect((error as AgCliError).exitCode).toBe(1);
    }
  });

  it("rejects a non-uuid conversation id in getConversationMetadata with runtime_error (review F9)", async () => {
    const instance = sandbox();
    const client = await connectedClient(instance);
    writeFileSync(
      instance.agentapiBin,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({conversation_id: process.argv[4], status: "CASCADE_RUN_STATUS_IDLE"}));\n',
      { mode: 0o755 },
    );
    try {
      await client.getConversationMetadata("../../victim");
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("runtime_error");
      expect((error as AgCliError).exitCode).toBe(1);
    }
  });

  it("rejects when the response body is cut off mid-json (review F5)", async () => {
    const instance = sandbox();
    const broken = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200);
        res.end("ok");
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      res.write('{"projects":');
      setTimeout(() => res.destroy(), 20);
    });
    const port = await new Promise<number>((resolve) => {
      broken.listen(0, "127.0.0.1", () => resolve((broken.address() as { port: number }).port));
    });
    servers.push({
      server: broken,
      port,
      csrfToken: "synthetic",
      requests: [],
      rpcCalls: [],
      close: () =>
        new Promise<void>((resolve) => {
          broken.close(() => resolve());
        }),
    });
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: port,
      httpsPort: 0,
      lsVersion: "broken",
      csrfToken: "synthetic",
    });
    writeMockAgentapi(instance);
    const client = await AgentApiClient.connect({
      antigravityDir: instance.antigravityDir,
      agentapiBin: instance.agentapiBin,
    });

    const deadline = new Promise<"hung">((resolve) => {
      setTimeout(() => resolve("hung"), 6000);
    });
    const outcome = await Promise.race([
      client
        .listProjects()
        .then(() => "resolved" as const)
        .catch((error: AgCliError) => {
          expect(error.kind).toBe("runtime_error");
          return "rejected" as const;
        }),
      deadline,
    ]);
    expect(outcome).toBe("rejected");
  });

  it("rejects invalid rpc json bodies and hanging servers past the deadline (review F5)", async () => {
    const instance = sandbox();
    const garbage = createServer((_req, res) => {
      if (_req.url === "/healthz") {
        res.writeHead(200);
        res.end("ok");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json at all");
    });
    const port = await new Promise<number>((resolve) => {
      garbage.listen(0, "127.0.0.1", () => resolve((garbage.address() as { port: number }).port));
    });
    servers.push({
      server: garbage,
      port,
      csrfToken: "synthetic",
      requests: [],
      rpcCalls: [],
      close: () =>
        new Promise<void>((resolve) => {
          garbage.close(() => resolve());
        }),
    });
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: port,
      httpsPort: 0,
      lsVersion: "garbage",
      csrfToken: "synthetic",
    });
    writeMockAgentapi(instance);
    const client = await AgentApiClient.connect({
      antigravityDir: instance.antigravityDir,
      agentapiBin: instance.agentapiBin,
    });
    try {
      await client.listProjects();
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).message).toContain("invalid json");
    }

    const hanging = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200);
        res.end("ok");
        return;
      }
      // never respond to the RPC
    });
    const hangPort = await new Promise<number>((resolve) => {
      hanging.listen(0, "127.0.0.1", () => resolve((hanging.address() as { port: number }).port));
    });
    servers.push({
      server: hanging,
      port: hangPort,
      csrfToken: "synthetic",
      requests: [],
      rpcCalls: [],
      close: () =>
        new Promise<void>((resolve) => {
          hanging.close(() => resolve());
        }),
    });
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: hangPort,
      httpsPort: 0,
      lsVersion: "hanging",
      csrfToken: "synthetic",
    });
    const slowClient = await AgentApiClient.connect({
      antigravityDir: instance.antigravityDir,
      agentapiBin: instance.agentapiBin,
      rpcTimeoutMs: 100,
    });
    try {
      await slowClient.listProjects();
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("runtime_error");
      expect((error as AgCliError).message).toContain("deadline exceeded");
    }
  });

  it("ignores project folders with unparsable file uris", async () => {
    const instance = sandbox();
    const client = await connectedClient(instance, {
      responses: {
        ListProjects: {
          projects: [{ projectId: "proj-bad", folderUri: "file://%%" }],
        },
      },
    });
    expect(await client.resolveProjectIdForCwd("/tmp/anything")).toBeNull();
  });

  it("listProjects and readProject call the language server with the csrf token", async () => {
    const instance = sandbox();
    const client = await connectedClient(instance, {
      responses: {
        ListProjects: {
          projects: [
            { projectId: "proj-a", folderUri: "file:///tmp/repo-a" },
            { projectId: "proj-b", folderUri: "/tmp/repo-b" },
          ],
        },
        ReadProject: { project: { projectId: "proj-a", folderUri: "file:///tmp/repo-a" } },
      },
    });

    const projects = await client.listProjects();
    expect(projects).toHaveLength(2);

    const project = await client.readProject("proj-a");
    expect(project).toMatchObject({ projectId: "proj-a" });

    const server = servers[0];
    const listCall = server?.rpcCalls.find((call) => call.method === "ListProjects");
    expect(listCall?.csrf).toBe(server?.csrfToken);
  });

  it("resolveProjectIdForCwd matches folderUri with and without the file scheme", async () => {
    const instance = sandbox();
    const client = await connectedClient(instance, {
      responses: {
        ListProjects: {
          projects: [
            { projectId: "proj-a", folderUri: "file:///tmp/repo-a" },
            { projectId: "proj-b", folderUri: "/tmp/repo-b" },
            { projectId: "proj-c" },
          ],
        },
      },
    });

    expect(await client.resolveProjectIdForCwd("/tmp/repo-a")).toBe("proj-a");
    expect(await client.resolveProjectIdForCwd("/tmp/repo-b")).toBe("proj-b");
    expect(await client.resolveProjectIdForCwd("/tmp/unknown")).toBeNull();
  });

  it("cancelCascadeInvocation posts the conversation id and succeeds on 200", async () => {
    const instance = sandbox();
    const client = await connectedClient(instance, { responses: { CancelCascadeInvocation: {} } });

    await client.cancelCascadeInvocation("990014f6-f6d1-4567-adcf-6182cead394c");
    const server = servers[0];
    const cancel = server?.rpcCalls.find((call) => call.method === "CancelCascadeInvocation");
    expect(cancel).toMatchObject({ csrf: server?.csrfToken });
  });

  it("rejects RPC failures with a clear runtime error", async () => {
    const instance = sandbox();
    const client = await connectedClient(instance, {
      responses: { ListProjects: {} },
      statusCodes: { ListProjects: 500 },
    });

    try {
      await client.listProjects();
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("runtime_error");
      expect((error as AgCliError).message).toContain("ListProjects");
    }
  });
});
