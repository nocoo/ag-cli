import { type CallerContext, detectCallerContext, wrapOutboundPrompt } from "../../domain/envelope";
import { resolveTarget } from "../../domain/target-resolver";
import { maxStepIndex } from "../../domain/transcript-parser";
import { AgentApiClient } from "../../infra/agentapi-client";
import { resolvePaths } from "../../infra/paths";
import { type DeliveryTicket, StateStore } from "../../infra/state-store";
import { openSummariesReader } from "../../infra/summaries-reader";
import { AgCliError } from "../../types/protocol";
import { emitJson, emitText, resolveMode, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";
import { awaitSettledStatus } from "./await-settled";
import { buildTargetRegistry, currentCallerId, observeConversation } from "./registry";

const IF_STATUSES = new Set(["idle", "done", "working"]);

export async function runSendCommand(
  args: string[],
  context: { env: Record<string, string | undefined>; stdout: StreamLike; stderr: StreamLike },
): Promise<number> {
  const flags = parseCommandFlags(args, {
    booleans: ["force", "wait", "no-notify", "raw", "json"],
    values: ["if", "timeout", "title"],
  });
  if (flags.positionals.length !== 2) {
    throw new AgCliError("invalid_usage", "send requires exactly a target and a message");
  }
  const target = flags.positionals[0] as string;
  const text = flags.positionals[1] as string;
  if (target.length === 0) {
    throw new AgCliError("invalid_usage", "send requires a target and a message");
  }
  if (text.length === 0) {
    throw new AgCliError("invalid_usage", "send requires a message");
  }
  const ifStatus = flags.values.get("if");
  if (ifStatus !== undefined && !IF_STATUSES.has(ifStatus)) {
    throw new AgCliError("invalid_usage", `--if expects idle, done or working, got ${ifStatus}`);
  }
  const timeoutSec = parseTimeout(flags.values.get("timeout"));

  const paths = resolvePaths(context.env);
  const store = StateStore.open(paths.stateDbPath, { create: true });
  const reader = openSummariesReader(paths.summariesDbPath);
  try {
    const resolved = resolveTarget(target, buildTargetRegistry(paths, reader, store), {
      callerId: currentCallerId(context.env),
    });
    const managedBefore = store.findByConversationId(resolved.conversationId);
    const observation = observeConversation(paths, reader, resolved.conversationId, store);
    const label =
      managedBefore === undefined
        ? resolved.conversationId.slice(0, 8)
        : `c${managedBefore.shortId}`;

    if (ifStatus !== undefined && observation.status !== ifStatus) {
      throw new AgCliError(
        "precondition_failed",
        `conversation ${label}${managedBefore?.name === null || managedBefore?.name === undefined ? "" : ` (${managedBefore.name})`} is currently ${observation.status}, expected ${ifStatus}`,
        { hint: "Run `ag-cli wait <c>` first or omit --if to queue the message." },
      );
    }
    if (observation.status === "blocked" && !flags.flags.has("force")) {
      throw new AgCliError(
        "blocked_conversation",
        `conversation ${label} is blocked waiting for approval or an answer`,
        { hint: "Inspect with `ag-cli read <c> --steps`, then resend with --force." },
      );
    }
    const queued = observation.status === "working";

    const caller = callerContext(detectCallerContext(context.env), store);
    const message = wrapOutboundPrompt(text, caller, {
      cwd: process.cwd(),
      noNotify: flags.flags.has("no-notify"),
      raw: flags.flags.has("raw"),
    });

    const watermarkStep = maxStepIndex(observation.steps) + 1;
    let ticket: DeliveryTicket | undefined;
    try {
      const client = await AgentApiClient.connect({
        antigravityDir: paths.antigravityDir,
        agentapiBin: paths.agentapiBin,
        baseEnv: context.env,
      });
      ticket = store.beginDelivery(resolved.conversationId, watermarkStep);
      await client.sendMessage(resolved.conversationId, message, {
        title: flags.values.get("title"),
      });
      store.commitDelivery(resolved.conversationId, ticket);
    } catch (error) {
      if (ticket !== undefined) {
        store.rollbackDelivery(resolved.conversationId, ticket);
      }
      throw error;
    }
    const row = store.findByConversationId(resolved.conversationId) as {
      shortId: number;
      name: string | null;
    };

    let waitReason: string | undefined;
    let waitStatus: string | undefined;
    let durationMs: number | undefined;
    if (flags.flags.has("wait")) {
      const outcome = await awaitSettledStatus({
        paths,
        reader,
        store,
        conversationId: resolved.conversationId,
        timeoutSec,
      });
      waitStatus = outcome.status;
      durationMs = outcome.durationMs;
      if (outcome.timedOut) {
        const mode = resolveMode({
          json: flags.flags.has("json"),
          tty: context.stdout.isTTY === true,
          pipedIsJson: true,
        });
        if (mode === "json") {
          emitJson(context.stdout, {
            conversationId: resolved.conversationId,
            shortId: `c${row.shortId}`,
            name: row.name,
            watermarkStep,
            queued,
            reason: "timeout",
            status: outcome.status,
            timedOut: true,
            durationMs: outcome.durationMs,
          });
        } else {
          emitText(
            context.stderr,
            `[ag-cli] still working as c${row.shortId}${row.name === null ? "" : ` (${row.name}, ${resolved.conversationId.slice(0, 8)})`}`,
          );
        }
        return 124;
      }
      waitReason = outcome.status;
    }

    const payload = {
      conversationId: resolved.conversationId,
      shortId: `c${row.shortId}`,
      name: row.name,
      watermarkStep,
      queued,
      ...(waitReason === undefined ? {} : { reason: waitReason, status: waitStatus, durationMs }),
    };
    const mode = resolveMode({
      json: flags.flags.has("json"),
      tty: context.stdout.isTTY === true,
      pipedIsJson: true,
    });
    if (mode === "json") {
      emitJson(context.stdout, payload);
    } else {
      emitText(
        context.stdout,
        `sent to c${row.shortId}${row.name === null ? "" : ` (${row.name})`} · watermark ${watermarkStep}${queued ? " · queued" : ""}`,
      );
    }
    return 0;
  } finally {
    reader?.close();
    store.close();
  }
}

function callerContext(caller: CallerContext | null, store: StateStore): CallerContext | null {
  if (caller === null || caller.kind !== "ag-cli") {
    return caller;
  }
  const row = store.findByConversationId(caller.conversationId);
  return { ...caller, shortId: row?.shortId, name: row?.name ?? undefined };
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) {
    return 180;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new AgCliError("invalid_usage", `--timeout expects a non-negative integer, got ${raw}`);
  }
  return value;
}
