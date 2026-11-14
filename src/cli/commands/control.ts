import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveTarget } from "../../domain/target-resolver";
import { assertUuid } from "../../domain/validation";
import { AgentApiClient } from "../../infra/agentapi-client";
import { assertInside } from "../../infra/path-safety";
import { resolvePaths } from "../../infra/paths";
import { StateStore } from "../../infra/state-store";
import { openSummariesReader } from "../../infra/summaries-reader";
import { AgCliError } from "../../types/protocol";
import { emitJson, emitText, resolveMode, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";
import { buildTargetRegistry, currentCallerId } from "./registry";

export type ControlVerb = "interrupt" | "kill" | "rm";

export async function runControlCommand(
  verb: ControlVerb,
  args: string[],
  context: { env: Record<string, string | undefined>; stdout: StreamLike },
): Promise<number> {
  const flags = parseCommandFlags(args, { booleans: ["json", "purge-brain"], values: [] });
  const target = flags.positionals[0];
  if (target === undefined) {
    throw new AgCliError("invalid_usage", `${verb} requires a target`);
  }

  const paths = resolvePaths(context.env);
  const store = StateStore.open(paths.stateDbPath, { create: true });
  const reader = openSummariesReader(paths.summariesDbPath);
  try {
    const resolved = resolveTarget(target, buildTargetRegistry(paths, reader, store), {
      callerId: currentCallerId(context.env),
    });
    const conversationId = resolved.conversationId;

    if (verb === "interrupt") {
      const client = await AgentApiClient.connect({
        antigravityDir: paths.antigravityDir,
        agentapiBin: paths.agentapiBin,
        baseEnv: context.env,
      });
      await client.cancelCascadeInvocation(conversationId);
      emitControlResult(context, flags.flags.has("json"), { conversationId, interrupted: true });
      return 0;
    }

    if (verb === "kill") {
      const row = store.ensureConversation(conversationId);
      try {
        const client = await AgentApiClient.connect({
          antigravityDir: paths.antigravityDir,
          agentapiBin: paths.agentapiBin,
          baseEnv: context.env,
        });
        await client.cancelCascadeInvocation(conversationId);
      } catch {
        // best-effort cancel: the state transition below is the source of truth
      }
      store.markTerminated(conversationId);
      emitControlResult(context, flags.flags.has("json"), {
        conversationId,
        shortId: row.shortId,
        terminated: true,
      });
      return 0;
    }

    assertUuid(conversationId);
    const row = store.findByConversationId(conversationId);
    if (row === undefined) {
      throw new AgCliError("not_found", `conversation ${conversationId} is not managed by ag-cli`, {
        hint: "Only ag-cli-registered conversations can be removed.",
      });
    }
    const brainTarget = join(paths.brainDir, conversationId);
    if (flags.flags.has("purge-brain") && existsSync(brainTarget)) {
      assertInside(paths.brainDir, brainTarget, "Brain artifacts must stay inside the brain root.");
    }
    store.removeConversation(conversationId);
    let purgedBrain = false;
    if (flags.flags.has("purge-brain")) {
      rmSync(brainTarget, { recursive: true, force: true });
      purgedBrain = true;
    }
    emitControlResult(context, flags.flags.has("json"), {
      conversationId,
      shortId: row.shortId,
      removed: true,
      purgedBrain,
    });
    return 0;
  } finally {
    reader?.close();
    store.close();
  }
}

function emitControlResult(
  context: { stdout: StreamLike },
  json: boolean,
  payload: Record<string, unknown>,
): void {
  const mode = resolveMode({ json, tty: context.stdout.isTTY === true, pipedIsJson: true });
  if (mode === "json") {
    emitJson(context.stdout, payload);
    return;
  }
  const text = Object.entries(payload)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
  emitText(context.stdout, text);
}
