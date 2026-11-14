import { resolveTarget } from "../../domain/target-resolver";
import { type ResolvedPaths, resolvePaths } from "../../infra/paths";
import { StateStore } from "../../infra/state-store";
import type { SummariesReader } from "../../infra/summaries-reader";
import { listBrainArtifacts, openSummariesReader } from "../../infra/summaries-reader";
import { TranscriptWatcher } from "../../infra/transcript-watcher";
import { AgCliError } from "../../types/protocol";
import { emitText, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";
import { buildTargetRegistry, currentCallerId, observeConversation } from "./registry";

const HC_OWNER_RE = /^hc:[A-Za-z0-9._-]+$/;

export interface EventsEvent {
  type: "created" | "status" | "step" | "turn" | "artifact" | "heartbeat";
  conversationId?: string;
  shortId?: string | null;
  name?: string | null;
  status?: string;
  stepIndex?: number;
  stepType?: string;
  stepStatus?: string;
  turn?: number;
  artifact?: { name: string; path: string };
  at: string;
}

interface TrackedConversation {
  shortId: string | null;
  name: string | null;
  status: string;
  inboundCount: number;
  artifacts: Set<string>;
}

export interface EventsOptions {
  abort?: AbortSignal;
  discoveryMs?: number;
}

export async function runEventsCommand(
  args: string[],
  context: { env: Record<string, string | undefined>; stdout: StreamLike },
  options: EventsOptions = {},
): Promise<number> {
  const flags = parseCommandFlags(args, {
    booleans: ["json"],
    values: ["target", "children-of", "heartbeat-ms", "discovery-ms"],
    repeatables: ["label"],
  });
  if (flags.positionals.length !== 0) {
    throw new AgCliError("invalid_usage", "events takes no positional arguments");
  }
  const labelFilters = flags.repeatable.get("label") ?? [];
  for (const pair of labelFilters) {
    if (pair.indexOf("=") < 1) {
      throw new AgCliError("invalid_usage", `invalid --label ${pair}`, {
        hint: "Use --label key=value.",
      });
    }
  }
  const heartbeatMs = parsePositive(flags.values.get("heartbeat-ms"), 15_000, "heartbeat-ms");
  const discoveryMs = parsePositive(
    flags.values.get("discovery-ms"),
    options.discoveryMs ?? 1000,
    "discovery-ms",
  );
  if (options.abort?.aborted === true) {
    return 0;
  }

  const paths = resolvePaths(context.env);
  let reader = openSummariesReader(paths.summariesDbPath);
  let store = StateStore.open(paths.stateDbPath);
  try {
    const callerId = currentCallerId(context.env);
    const filterTarget = flags.values.get("target") ?? flags.values.get("children-of");
    const childrenMode = flags.values.has("children-of");
    const owner =
      filterTarget === undefined
        ? undefined
        : resolveFilterOwner(filterTarget, paths, reader, store, callerId);

    const reopenDatabases = (): void => {
      if (reader === null) {
        reader = openSummariesReader(paths.summariesDbPath);
      }
      if (store === null) {
        store = StateStore.open(paths.stateDbPath);
      }
    };

    const discover = (): string[] => {
      reopenDatabases();
      const managed = store?.listManaged({ activeOnly: true }) ?? [];
      const ids: string[] = [];
      if (owner !== undefined) {
        if (!childrenMode) {
          ids.push(owner.conversationId);
        } else {
          for (const row of managed) {
            if (row.parentId === owner.conversationId) {
              ids.push(row.conversationId);
            }
          }
          for (const row of reader?.listConversations() ?? []) {
            if (row.parent_conversation_id === owner.conversationId && row.killed === 0) {
              ids.push(row.conversation_id);
            }
          }
        }
      } else {
        for (const row of managed) {
          if (matchesLabels(store, row.conversationId, labelFilters)) {
            ids.push(row.conversationId);
          }
        }
        if (labelFilters.length === 0) {
          for (const row of reader?.listConversations() ?? []) {
            if (row.killed === 0) {
              ids.push(row.conversation_id);
            }
          }
        }
      }
      const unique = [...new Set(ids)];
      return labelFilters.length > 0
        ? unique.filter((id) => matchesLabels(store, id, labelFilters))
        : unique;
    };

    const tty = context.stdout.isTTY === true && !flags.flags.has("json");
    const tracked = new Map<string, TrackedConversation>();
    const watchers = new Map<string, TranscriptWatcher>();
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let discoveryTimer: ReturnType<typeof setInterval> | undefined;
    let resolveRun: ((code: number) => void) | undefined;
    let rejectRun: ((error: unknown) => void) | undefined;

    const emit = (event: EventsEvent): void => {
      if (tty) {
        emitText(context.stdout, renderHuman(event));
      } else {
        context.stdout.write(`${JSON.stringify(event)}\n`);
      }
    };

    const cleanup = (): void => {
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (discoveryTimer !== undefined) {
        clearInterval(discoveryTimer);
        discoveryTimer = undefined;
      }
      for (const watch of watchers.values()) {
        watch.close();
      }
      watchers.clear();
      options.abort?.removeEventListener("abort", onAbort);
      if (options.abort === undefined) {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }
    };

    const stop = (): void => {
      cleanup();
      resolveRun?.(0);
    };

    const fail = (error: unknown): void => {
      cleanup();
      rejectRun?.(error);
    };

    const guarded = (action: () => void): void => {
      try {
        action();
      } catch (error) {
        fail(error);
      }
    };

    const onSignal = (): void => {
      stop();
    };
    const onAbort = (): void => {
      stop();
    };

    const describeLive = (conversationId: string): TrackedConversation => {
      const observation = observeConversation(paths, reader, conversationId, store);
      return {
        shortId:
          observation.managed === undefined || observation.managed === null
            ? null
            : `c${observation.managed.shortId}`,
        name: observation.managed?.name ?? null,
        status: observation.status as string,
        inboundCount: 0,
        artifacts: new Set(),
      };
    };

    const attach = (conversationId: string, announce: boolean): void => {
      const entry = describeLive(conversationId);
      tracked.set(conversationId, entry);
      const watch: TranscriptWatcher = new TranscriptWatcher({
        antigravityDir: paths.antigravityDir,
        conversationId,
        summariesDbPath: paths.summariesDbPath,
        stateDbPath: paths.stateDbPath,
        debounceMs: 20,
        fallbackMs: 1000,
        onChange: () => {
          guarded(() => {
            handleChange(conversationId, watch);
          });
        },
      });
      watch.start();
      const primed = watch.readNewSteps();
      entry.inboundCount = primed.filter(
        (step) => step.type === "USER_INPUT" || step.type === "SYSTEM_MESSAGE",
      ).length;
      entry.artifacts = new Set(
        listBrainArtifacts(paths.brainDir, conversationId).map((artifact) => artifact.name),
      );
      watchers.set(conversationId, watch);
      if (announce) {
        emit({
          type: "created",
          conversationId,
          shortId: entry.shortId,
          name: entry.name,
          status: entry.status,
          at: timestamp(),
        });
      }
    };

    const handleChange = (conversationId: string, watch: TranscriptWatcher): void => {
      const freshSteps = watch.readNewSteps();
      const entry = tracked.get(conversationId);
      if (entry === undefined) {
        return;
      }
      for (const step of freshSteps) {
        emit({
          type: "step",
          conversationId,
          shortId: entry.shortId,
          stepIndex: step.step_index,
          stepType: step.type,
          stepStatus: step.status,
          at: timestamp(),
        });
        if (step.type === "USER_INPUT" || step.type === "SYSTEM_MESSAGE") {
          entry.inboundCount += 1;
          emit({
            type: "turn",
            conversationId,
            shortId: entry.shortId,
            turn: entry.inboundCount,
            at: timestamp(),
          });
        }
      }
      const observation = observeConversation(
        paths,
        reader,
        conversationId,
        store,
        watch.currentSteps(),
      );
      if (observation.status !== entry.status) {
        entry.status = observation.status;
        emit({
          type: "status",
          conversationId,
          shortId: entry.shortId,
          name: entry.name,
          status: entry.status,
          at: timestamp(),
        });
      }
      for (const artifact of listBrainArtifacts(paths.brainDir, conversationId)) {
        if (!entry.artifacts.has(artifact.name)) {
          entry.artifacts.add(artifact.name);
          emit({
            type: "artifact",
            conversationId,
            shortId: entry.shortId,
            artifact: { name: artifact.name, path: artifact.path },
            at: timestamp(),
          });
        }
      }
    };

    return await new Promise<number>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
      options.abort?.addEventListener("abort", onAbort);
      if (options.abort === undefined) {
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
      }

      guarded(() => {
        for (const conversationId of discover()) {
          attach(conversationId, false);
        }
      });
      heartbeatTimer = setInterval(() => {
        guarded(() => {
          emit({ type: "heartbeat", at: timestamp() });
        });
      }, heartbeatMs);
      discoveryTimer = setInterval(() => {
        guarded(() => {
          const current = new Set(discover());
          for (const conversationId of current) {
            if (!tracked.has(conversationId)) {
              attach(conversationId, true);
            }
          }
          for (const conversationId of [...tracked.keys()]) {
            if (!current.has(conversationId)) {
              watchers.get(conversationId)?.close();
              watchers.delete(conversationId);
              tracked.delete(conversationId);
            }
          }
        });
      }, discoveryMs);
    });
  } finally {
    reader?.close();
    store?.close();
  }
}

function resolveFilterOwner(
  owner: string,
  paths: ResolvedPaths,
  reader: SummariesReader | null,
  store: StateStore | null,
  callerId: string | undefined,
): { conversationId: string } {
  const trimmed = owner.trim();
  if (HC_OWNER_RE.test(trimmed)) {
    return { conversationId: trimmed };
  }
  return resolveTarget(trimmed, buildTargetRegistry(paths, reader, store), { callerId });
}
function matchesLabels(
  store: StateStore | null,
  conversationId: string,
  labelFilters: string[],
): boolean {
  const labels = Object.fromEntries(
    (store?.listLabels(conversationId) ?? []).map((label) => [label.key, label.value]),
  );
  return labelFilters.every((pair) => {
    const separator = pair.indexOf("=");
    return labels[pair.slice(0, separator)] === pair.slice(separator + 1);
  });
}

function renderHuman(event: EventsEvent): string {
  const time = event.at.slice(11, 19);
  const label = event.shortId ?? (event.conversationId ?? "").slice(0, 8);
  switch (event.type) {
    case "heartbeat":
      return `${time} heartbeat`;
    case "created":
      return `${time} ${label} created ${event.status ?? ""}`.trimEnd();
    case "step":
      return `${time} ${label} step ${event.stepIndex} ${event.stepType} ${event.stepStatus}`;
    case "turn":
      return `${time} ${label} turn ${event.turn}`;
    case "status":
      return `${time} ${label} status ${event.status}`;
    case "artifact":
      return `${time} ${label} artifact ${event.artifact?.name ?? ""}`;
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function parsePositive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new AgCliError("invalid_usage", `--${name} expects a positive integer, got ${raw}`);
  }
  return value;
}
