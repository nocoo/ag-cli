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
  const created = createSandbox("nullg-int-wait");
  active.push(created);
  return created;
}

function context(env: Record<string, string> = {}): CliContext {
  const make = () => {
    const stream = {
      isTTY: false,
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

function stdoutJson<T>(ctx: CliContext): T {
  return JSON.parse((ctx.stdout as unknown as { chunks: string[] }).chunks.join("")) as T;
}

afterEach(() => {
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

describe("wait against the live mock stack", () => {
  it("resolves done while a child completes through real watcher events", async () => {
    const instance = sandbox();
    initSummariesDb(instance);
    writeMockAgentapi(instance);
    const parent = "8f8f8f8f-8f8f-48f8-88f8-8f8f8f8f8f8f";
    const childCreated = runAgentapi(instance, ["new-conversation", "--message", "child work"], {
      AG_MOCK_AGENTAPI_MODE: "stuck",
    });
    const child = (JSON.parse(childCreated.stdout) as { conversationId: string }).conversationId;
    const paths = resolvePaths(instance.env);
    const store = StateStore.open(paths.stateDbPath, { create: true });
    store.registerConversation(child, { name: "live-child", parentId: parent });
    store.close();
    const ownerDb = initSummariesDb(instance);
    ownerDb
      .prepare("INSERT INTO conversation_summaries (conversation_id, title) VALUES (?, ?)")
      .run(parent, "owner");
    ownerDb.close();

    const ctx = context({ ...instance.env, NULLG_CALLER_ID: parent });
    const waitPromise = runCli(["wait", "--children", "any", "--json", "--timeout", "10"], ctx);
    await new Promise((resolve) => setTimeout(resolve, 400));
    runAgentapi(instance, ["send-message", "--conversation-id", child, "--message", "finish it"]);
    const code = await waitPromise;
    expect(code).toBe(0);
    expect(stdoutJson<{ reason: string; target: { conversationId: string } }>(ctx)).toMatchObject({
      reason: "done",
      target: { conversationId: child },
    });
  }, 20000);
});
