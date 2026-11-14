import { resolveTarget } from "../../domain/target-resolver";
import { latestReply, maxStepIndex } from "../../domain/transcript-parser";
import { type ResolvedPaths, resolvePaths } from "../../infra/paths";
import { StateStore } from "../../infra/state-store";
import {
  type ConversationSummaryRow,
  openSummariesReader,
  type SummariesReader,
} from "../../infra/summaries-reader";
import { TranscriptWatcher } from "../../infra/transcript-watcher";
import type { ConversationStatus } from "../../types/protocol";
import { AgCliError } from "../../types/protocol";
import { emitJson, emitText, resolveMode, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";
import { awaitSettledStatus } from "./await-settled";
import {
  buildTargetRegistry,
  currentCallerId,
  loadTranscriptSteps,
  observeConversation,
} from "./registry";

const SETTLED = new Set<ConversationStatus>(["done", "blocked", "error"]);
const CHILDREN_MODES = new Set(["any", "all"]);

export async function runWaitCommand(
  args: string[],
  context: { env: Record<string, string | undefined>; stdout: StreamLike; stderr: StreamLike },
): Promise<number> {
  const flags = parseCommandFlags(args, { booleans: ["json"], values: ["children", "timeout"] });
  const childrenMode = flags.values.get("children");
  if (childrenMode !== undefined && !CHILDREN_MODES.has(childrenMode)) {
    throw new AgCliError("invalid_usage", `--children expects any or all, got ${childrenMode}`);
  }
  const timeoutSec = parseTimeout(flags.values.get("timeout"));

  const paths = resolvePaths(context.env);
  const reader = openSummariesReader(paths.summariesDbPath);
  const store = StateStore.open(paths.stateDbPath);
  try {
    const callerId = currentCallerId(context.env);
    const registry = buildTargetRegistry(paths, reader, store);

    if (childrenMode !== undefined) {
      const owner = flags.positionals[0] ?? callerId;
      if (owner === undefined) {
        throw new AgCliError(
          "invalid_usage",
          "missing_target: --children needs a caller conversation",
          {
            hint: "Pass a target or run inside an Antigravity conversation.",
          },
        );
      }
      let ownerId: string;
      try {
        ownerId = resolveTarget(owner, registry, { callerId }).conversationId;
      } catch {
        ownerId = owner.trim();
      }
      const outcome = await waitForChildren({
        paths,
        reader,
        store,
        ownerId,
        mode: childrenMode === "any" ? "any" : "all",
        timeoutSec,
      });
      const timedOut = outcome.reason === "timeout";
      emitWaitResult(context, flags.flags.has("json"), outcome, timedOut);
      return timedOut ? 124 : 0;
    }

    const resolved = resolveTarget(flags.positionals[0], registry, { callerId });
    const outcome = await awaitSettledStatus({
      paths,
      reader,
      store,
      conversationId: resolved.conversationId,
      timeoutSec,
    });
    const reason = outcome.timedOut ? "timeout" : outcome.status;
    const observation = observeConversation(paths, reader, resolved.conversationId, store);
    emitWaitResult(
      context,
      flags.flags.has("json"),
      {
        reason,
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
        target: toTargetSummary(
          resolved.conversationId,
          observation.managed?.shortId,
          observation.managed?.name,
          observation.status,
          observation.turns.length,
          observation.telemetry.stepCount,
        ),
        latestReplyPreview: latestReply(observation.steps)?.content ?? "",
        children: [],
      },
      outcome.timedOut,
    );
    return outcome.timedOut ? 124 : 0;
  } finally {
    reader?.close();
    store?.close();
  }
}

export interface WaitResult {
  reason: string;
  timedOut: boolean;
  durationMs: number;
  target: {
    conversationId: string;
    shortId: number | null;
    name: string | null;
    status: string;
    turn: number;
    stepCount: number;
  };
  latestReplyPreview: string;
  children: Array<{
    conversationId: string;
    shortId: number | null;
    name: string | null;
    status: string;
  }>;
}

function toTargetSummary(
  conversationId: string,
  shortId: number | undefined,
  name: string | null | undefined,
  status: string,
  turn: number,
  stepCount: number,
): WaitResult["target"] {
  return {
    conversationId,
    shortId: shortId ?? null,
    name: name ?? null,
    status,
    turn,
    stepCount,
  };
}

interface ChildCandidate {
  conversationId: string;
  summary?: ConversationSummaryRow;
}

function findChildren(
  reader: SummariesReader | null,
  store: StateStore | null,
  ownerId: string,
): ChildCandidate[] {
  const children: ChildCandidate[] = [];
  const seen = new Set<string>();
  for (const row of store?.listManaged() ?? []) {
    if (row.parentId === ownerId && !seen.has(row.conversationId)) {
      seen.add(row.conversationId);
      children.push({ conversationId: row.conversationId });
    }
  }
  for (const row of reader?.listConversations() ?? []) {
    if (row.parent_conversation_id === ownerId && !seen.has(row.conversation_id)) {
      seen.add(row.conversation_id);
      children.push({ conversationId: row.conversation_id, summary: row });
    }
  }
  return children;
}

async function waitForChildren(options: {
  paths: ResolvedPaths;
  reader: SummariesReader | null;
  store: StateStore | null;
  ownerId: string;
  mode: "any" | "all";
  timeoutSec: number;
}): Promise<WaitResult> {
  const start = Date.now();
  const callerBaseline = maxStepIndex(
    loadTranscriptSteps(options.paths.antigravityDir, options.ownerId),
  );
  const children = findChildren(options.reader, options.store, options.ownerId);

  const summarize = (): WaitResult => {
    const observed = children.map((child) => {
      const observation = observeConversation(
        options.paths,
        options.reader,
        child.conversationId,
        options.store,
      );
      return {
        conversationId: child.conversationId,
        shortId: observation.managed?.shortId ?? null,
        name: observation.managed?.name ?? null,
        status: observation.status as string,
      };
    });
    let decided: WaitResult["target"];
    if (options.mode === "any") {
      const settled = observed.find((child) => SETTLED.has(child.status as ConversationStatus));
      decided =
        settled === undefined
          ? toTargetSummary(options.ownerId, undefined, undefined, "working", 0, 0)
          : {
              ...settled,
              turn: 0,
              stepCount: 0,
            };
    } else {
      const priority =
        observed.find((child) => child.status === "error") ??
        observed.find((child) => child.status === "blocked") ??
        observed[observed.length - 1];
      decided =
        priority === undefined
          ? toTargetSummary(options.ownerId, undefined, undefined, "done", 0, 0)
          : { ...priority, turn: 0, stepCount: 0 };
    }
    return {
      reason: "timeout",
      timedOut: true,
      durationMs: Date.now() - start,
      target: decided,
      latestReplyPreview: "",
      children: observed,
    };
  };

  const evaluate = (): { done: boolean; reason?: string; childId?: string } => {
    if (options.mode === "any") {
      const settled = children.find((child) =>
        SETTLED.has(
          observeConversation(options.paths, options.reader, child.conversationId, options.store)
            .status,
        ),
      );
      if (settled !== undefined) {
        return { done: true, reason: "settled", childId: settled.conversationId };
      }
      const callerSteps = loadTranscriptSteps(options.paths.antigravityDir, options.ownerId);
      const newInbound = callerSteps.some(
        (step) =>
          step.step_index > callerBaseline &&
          (step.type === "USER_INPUT" || step.type === "SYSTEM_MESSAGE"),
      );
      if (newInbound) {
        return { done: true, reason: "message" };
      }
      return { done: false };
    }
    const allIdle = children.every(
      (child) =>
        observeConversation(options.paths, options.reader, child.conversationId, options.store)
          .status !== "working",
    );
    return allIdle ? { done: true, reason: "settled" } : { done: false };
  };

  return new Promise<WaitResult>((resolve) => {
    const watchers: TranscriptWatcher[] = [];
    const trackedIds = [options.ownerId, ...children.map((child) => child.conversationId)];
    for (const conversationId of trackedIds) {
      const watcher = new TranscriptWatcher({
        antigravityDir: options.paths.antigravityDir,
        conversationId,
        summariesDbPath: options.paths.summariesDbPath,
        debounceMs: 20,
        fallbackMs: 500,
        onChange: () => {
          tick();
        },
      });
      watcher.start();
      watchers.push(watcher);
    }

    const finish = (result: WaitResult): void => {
      clearTimeout(deadlineTimer);
      for (const watcher of watchers) {
        watcher.close();
      }
      resolve(result);
    };

    const tick = (): void => {
      const outcome = evaluate();
      if (!outcome.done) {
        return;
      }
      const summary = summarize();
      if (outcome.reason === "message") {
        finish({ ...summary, reason: "message", timedOut: false });
        return;
      }
      const decidedId = outcome.childId;
      const decidedChild =
        decidedId === undefined
          ? summary.target
          : summary.children.find((child) => child.conversationId === decidedId);
      const status = decidedChild?.status ?? "done";
      const target =
        decidedChild === undefined ? summary.target : { ...summary.target, ...decidedChild };
      finish({ ...summary, reason: status, timedOut: false, target });
    };

    const deadlineTimer = setTimeout(() => {
      finish(summarize());
    }, options.timeoutSec * 1000);
    tick();
  });
}

function emitWaitResult(
  context: { stdout: StreamLike },
  json: boolean,
  result: WaitResult,
  timedOut: boolean,
): void {
  const mode = resolveMode({ json, tty: context.stdout.isTTY === true, pipedIsJson: true });
  if (mode === "json") {
    emitJson(context.stdout, result);
    return;
  }
  const label =
    result.target.shortId === null
      ? result.target.conversationId.slice(0, 8)
      : `c${result.target.shortId}${result.target.name === null ? "" : ` (${result.target.name})`}`;
  const lines = [
    `${label} · ${result.reason} · ${(result.durationMs / 1000).toFixed(1)}s${timedOut ? " (timeout)" : ""}`,
  ];
  if (result.latestReplyPreview.length > 0) {
    lines.push(result.latestReplyPreview.slice(0, 120));
  }
  emitText(context.stdout, lines.join("\n"));
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
