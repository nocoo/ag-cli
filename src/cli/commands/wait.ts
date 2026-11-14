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
import { NullgError } from "../../types/protocol";
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
  if (flags.positionals.length > 1) {
    throw new NullgError("invalid_usage", "wait accepts at most one target");
  }
  const childrenMode = flags.values.get("children");
  if (childrenMode !== undefined && !CHILDREN_MODES.has(childrenMode)) {
    throw new NullgError("invalid_usage", `--children expects any or all, got ${childrenMode}`);
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
        throw new NullgError(
          "invalid_usage",
          "missing_target: --children needs a caller conversation",
          {
            hint: "Pass a target or run inside an Antigravity conversation.",
          },
        );
      }
      const ownerId = resolveOwnerId(owner, registry, callerId);
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
    shortId: string | null;
    name: string | null;
    status: string;
    turn: number;
    stepCount: number;
  };
  latestReplyPreview: string;
  children: Array<{
    conversationId: string;
    shortId: string | null;
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
    shortId: shortId === undefined ? null : `c${shortId}`,
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
  const allManaged = store?.listManaged() ?? [];
  const managedById = new Map(allManaged.map((row) => [row.conversationId, row]));
  const added = new Set<string>();
  const killed = new Set(
    (reader?.listConversations() ?? [])
      .filter((row) => row.killed === 1)
      .map((row) => row.conversation_id),
  );
  for (const row of allManaged) {
    if (row.terminated === 1 || killed.has(row.conversationId)) {
      continue;
    }
    if (row.parentId === ownerId && !added.has(row.conversationId)) {
      added.add(row.conversationId);
      children.push({ conversationId: row.conversationId });
    }
  }
  for (const row of reader?.listConversations() ?? []) {
    if (row.killed === 1 || added.has(row.conversation_id)) {
      continue;
    }
    const managedRow = managedById.get(row.conversation_id);
    if (managedRow !== undefined && managedRow.terminated === 1) {
      continue;
    }
    // locally adopted rows may lack a parent id; keep the native relation then
    const effectiveParent = managedRow?.parentId ?? row.parent_conversation_id;
    if (effectiveParent === ownerId) {
      added.add(row.conversation_id);
      children.push({ conversationId: row.conversation_id, summary: row });
    }
  }
  return children;
}

const HC_OWNER_RE = /^hc:[A-Za-z0-9._-]+$/;

function resolveOwnerId(
  owner: string,
  registry: ReturnType<typeof buildTargetRegistry>,
  callerId: string | undefined,
): string {
  const trimmed = owner.trim();
  try {
    return resolveTarget(trimmed, registry, { callerId }).conversationId;
  } catch (error) {
    if (HC_OWNER_RE.test(trimmed)) {
      return trimmed;
    }
    throw error;
  }
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
  const watchers = new Map<string, TranscriptWatcher>();
  let settled = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = (): void => {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    for (const watcher of watchers.values()) {
      watcher.close();
    }
    watchers.clear();
  };
  let resolvePromise: (result: WaitResult) => void = () => {};
  let rejectPromise: (error: unknown) => void = () => {};
  const promise = new Promise<WaitResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const fail = (error: unknown): void => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    rejectPromise(error);
  };
  const guarded = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      fail(error);
    }
  };

  let tick: () => void = () => {};
  let callerBaseline = -1;
  let children: ChildCandidate[] = [];
  try {
    callerBaseline = maxStepIndex(
      loadTranscriptSteps(options.paths.antigravityDir, options.ownerId),
    );
    children = findChildren(options.reader, options.store, options.ownerId);
    const trackedIds = [options.ownerId, ...children.map((child) => child.conversationId)];
    for (const conversationId of trackedIds) {
      const watcher = new TranscriptWatcher({
        antigravityDir: options.paths.antigravityDir,
        conversationId,
        summariesDbPath: options.paths.summariesDbPath,
        stateDbPath: options.paths.stateDbPath,
        debounceMs: 20,
        fallbackMs: 500,
        onChange: () => {
          guarded(tick);
        },
      });
      watchers.set(conversationId, watcher);
      watcher.start();
      watcher.readNewSteps();
    }
  } catch (error) {
    fail(error);
    return promise;
  }
  const observe = (conversationId: string) =>
    observeConversation(
      options.paths,
      options.reader,
      conversationId,
      options.store,
      watchers.get(conversationId)?.currentSteps(),
    );

  const childSummaries = () =>
    children.map((child) => {
      const observation = observe(child.conversationId);
      return {
        observation,
        entry: {
          conversationId: child.conversationId,
          shortId:
            observation.managed === undefined || observation.managed === null
              ? null
              : `c${observation.managed.shortId}`,
          name: observation.managed?.name ?? null,
          status: observation.status as string,
        },
      };
    });

  const summarize = (): WaitResult => {
    const observed = childSummaries();
    let decided: WaitResult["target"];
    if (options.mode === "any") {
      const settled = observed.find((child) => SETTLED.has(child.observation.status));
      decided =
        settled === undefined
          ? toTargetSummary(options.ownerId, undefined, undefined, "working", 0, 0)
          : {
              ...settled.entry,
              turn: settled.observation.turns.length,
              stepCount: settled.observation.telemetry.stepCount,
            };
      const preview =
        settled === undefined ? "" : (latestReply(settled.observation.steps)?.content ?? "");
      return {
        reason: "timeout",
        timedOut: true,
        durationMs: Date.now() - start,
        target: decided,
        latestReplyPreview: preview,
        children: observed.map((child) => child.entry),
      };
    }
    const priority =
      observed.find((child) => child.observation.status === "error") ??
      observed.find((child) => child.observation.status === "blocked") ??
      observed[observed.length - 1];
    decided =
      priority === undefined
        ? toTargetSummary(options.ownerId, undefined, undefined, "done", 0, 0)
        : {
            ...priority.entry,
            turn: priority.observation.turns.length,
            stepCount: priority.observation.telemetry.stepCount,
          };
    const preview =
      priority === undefined ? "" : (latestReply(priority.observation.steps)?.content ?? "");
    return {
      reason: "timeout",
      timedOut: true,
      durationMs: Date.now() - start,
      target: decided,
      latestReplyPreview: preview,
      children: observed.map((child) => child.entry),
    };
  };

  const evaluate = (): { done: boolean; reason?: string; childId?: string } => {
    if (options.mode === "any") {
      for (const child of children) {
        if (SETTLED.has(observe(child.conversationId).status)) {
          return { done: true, reason: "settled", childId: child.conversationId };
        }
      }
      const callerSteps = (watchers.get(options.ownerId) as TranscriptWatcher).currentSteps();
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
    const allIdle = children.every((child) => observe(child.conversationId).status !== "working");
    return allIdle ? { done: true, reason: "settled" } : { done: false };
  };

  const finish = (result: WaitResult): void => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    resolvePromise(result);
  };

  tick = (): void => {
    for (const watcher of watchers.values()) {
      watcher.readNewSteps();
    }
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
        ? summary.children.find((child) => child.conversationId === summary.target.conversationId)
        : summary.children.find((child) => child.conversationId === decidedId);
    const rawStatus = decidedChild?.status ?? summary.target.status;
    const status = rawStatus === "idle" ? "done" : rawStatus;
    const target =
      decidedChild === undefined ? summary.target : { ...summary.target, ...decidedChild };
    finish({ ...summary, reason: status, timedOut: false, target });
  };

  if (options.timeoutSec > 0) {
    deadlineTimer = setTimeout(() => {
      guarded(() => {
        tick();
        if (!settled) {
          finish(summarize());
        }
      });
    }, options.timeoutSec * 1000);
  }
  guarded(tick);
  return promise;
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
      : `${result.target.shortId}${result.target.name === null ? "" : ` (${result.target.name})`}`;
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
    throw new NullgError("invalid_usage", `--timeout expects a non-negative integer, got ${raw}`);
  }
  return value;
}
