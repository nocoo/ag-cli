import { afterEach, describe, expect, it } from "vitest";
import { AgentApiClient } from "../../src/infra/agentapi-client";
import { openSummariesReader } from "../../src/infra/summaries-reader";
import {
  createSandbox,
  initSummariesDb,
  readTranscript,
  type Sandbox,
  startMockLanguageServer,
  writeHubFile,
  writeMockAgentapi,
} from "../helpers/sandbox";

const active: Sandbox[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

function sandbox(): Sandbox {
  const created = createSandbox("ag-cli-int-agentapi");
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

describe("AgentApiClient async delivery", () => {
  it("returns the receipt before the inbound lands on disk", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const mock = await startMockLanguageServer();
    servers.push(mock);
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: mock.port,
      httpsPort: mock.port,
      lsVersion: "async",
      csrfToken: mock.csrfToken,
    });
    const client = await AgentApiClient.connect({
      antigravityDir: instance.antigravityDir,
      agentapiBin: instance.agentapiBin,
      baseEnv: {
        ...process.env,
        AG_MOCK_AGENTAPI_ASYNC: "1",
        AG_MOCK_AGENTAPI_ASYNC_DELAY_MS: "400",
      },
    });

    const receiptStarted = Date.now();
    const created = await client.newConversation({ message: "deferred" });
    expect(Date.now() - receiptStarted).toBeLessThan(1000);
    expect(readTranscript(instance, created.conversationId)).toEqual([]);

    const settleStarted = Date.now();
    let steps = readTranscript(instance, created.conversationId);
    while (steps.length < 3 && Date.now() - settleStarted < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      steps = readTranscript(instance, created.conversationId);
    }
    expect(steps.length).toBe(3);
    expect(steps.at(-1)).toMatchObject({ type: "PLANNER_RESPONSE", status: "DONE" });
  }, 15000);
});

describe("AgentApiClient end-to-end against the mock stack", () => {
  it("connects through discovery and drives a full conversation", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const mock = await startMockLanguageServer({
      responses: {
        ListProjects: { projects: [{ projectId: "proj-e2e", folderUri: "file:///tmp/e2e" }] },
        CancelCascadeInvocation: {},
      },
    });
    servers.push(mock);
    writeHubFile(instance, {
      pid: process.pid,
      httpPort: mock.port,
      httpsPort: mock.port,
      lsVersion: "int",
      csrfToken: mock.csrfToken,
    });

    const client = await AgentApiClient.connect({
      antigravityDir: instance.antigravityDir,
      agentapiBin: instance.agentapiBin,
    });

    const created = await client.newConversation({ message: "integration run", title: "int job" });
    const sent = await client.sendMessage(created.conversationId, "follow up");
    expect(sent.stepIndex).toBe(3);

    const steps = readTranscript(instance, created.conversationId);
    expect(steps.length).toBe(6);
    expect(steps.at(-1)).toMatchObject({ type: "PLANNER_RESPONSE", status: "DONE" });

    const reader = openSummariesReader(instance.summariesDbPath);
    expect(reader?.getConversation(created.conversationId)).toMatchObject({
      title: "int job",
      status: "CASCADE_RUN_STATUS_IDLE",
    });
    reader?.close();

    expect(await client.resolveProjectIdForCwd("/tmp/e2e")).toBe("proj-e2e");
    await client.cancelCascadeInvocation(created.conversationId);
    expect(
      mock.rpcCalls.find((call) => call.method === "CancelCascadeInvocation")?.body,
    ).toMatchObject({ conversationId: created.conversationId });
  });
});
