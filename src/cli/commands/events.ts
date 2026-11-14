import { resolveTarget } from "../../domain/target-resolver";
import { resolvePaths } from "../../infra/paths";
import { StateStore } from "../../infra/state-store";
import { openSummariesReader } from "../../infra/summaries-reader";
import { TranscriptWatcher } from "../../infra/transcript-watcher";
import { AgCliError, type ConversationStatus } from "../../types/protocol";
import { emitText, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";
import { buildTargetRegistry, currentCallerId, observeConversation } from "./registry";

const SETTLED = new Set<ConversationStatus>(["done", "blocked", "error"]);

interface TrackedConversation {
  conversationId: string;
  shortId: number | null;
  name: string | null;
  status: ConversationStatus;
}

export interface EventsEvent {
  type: "state" | "step" | "terminal" | "heartbeat";
  conversationId?: string;
  shortId?: number | null;
  name?: string | null;
  status?: string;
  stepIndex?: number;
  stepType?: string;
  stepStatus?: string;
  at: string;
}

export async function runEventsCommand(
  args: string[],
  context: { env: Record<string, string | undefined>; stdout: StreamLike },
  options: { abort?: AbortSignal } = {},
): Promise<number> {
  const flags = parseCommandFlags(args, {
    booleans: [],
    values: ["target", "children-of", "heartbeat-ms"],
    repeatables: ["label"],
  });
  const labelFilters = flags.repeatable.get("label") ?? [];
  for (const pair of labelFilters) {
    if (pair.indexOf("=") < 1) {
      throw new AgCliError("invalid_usage", `invalid --label ${pair}`, {
        hint: "Use --label key=value.",
      });
    }
  }
  const heartbeatMs = parseHeartbeat(flags.values.get("heartbeat-ms"));

  const paths = resolvePaths(context.env);
  const reader = openSummariesReader(paths.summariesDbPath);
  const store = StateStore.open(paths.stateDbPath);
  try {
    const registry = buildTargetRegistry(paths, reader, store);
    const callerId = currentCallerId(context.env);
    const tracked: TrackedConversation[] = [];

    const pushTracked = (conversationId: string): void => {
      const observation = observeConversation(paths, reader, conversationId, store);
      tracked.push({
        conversationId,
        shortId: observation.managed?.shortId ?? null,
        name: observation.managed?.name ?? null,
        status: observation.status,
      });
    };

    if (flags.values.has("target")) {
      const resolved = resolveTarget(flags.values.get("target") as string, registry, { callerId });
      pushTracked(resolved.conversationId);
    } else if (flags.values.has("children-of")) {
      const rawOwner = flags.values.get("children-of") as string;
      let ownerId: string;
      try {
        ownerId = resolveTarget(rawOwner, registry, { callerId }).conversationId;
      } catch {
        ownerId = rawOwner.trim();
      }
      for (const row of store?.listManaged() ?? []) {
        if (row.parentId === ownerId) {
          pushTracked(row.conversationId);
        }
      }
      for (const row of reader?.listConversations() ?? []) {
        if (row.parent_conversation_id === ownerId) {
          if (!tracked.some((entry) => entry.conversationId === row.conversation_id)) {
            pushTracked(row.conversation_id);
          }
        }
      }
    } else {
      const seen = new Set<string>();
      for (const row of store?.listManaged({ activeOnly: true }) ?? []) {
        if (
          !seen.has(row.conversationId) &&
          matchesLabels(store, row.conversationId, labelFilters)
        ) {
          seen.add(row.conversationId);
          pushTracked(row.conversationId);
        }
      }
      for (const row of reader?.listConversations() ?? []) {
        if (seen.has(row.conversation_id) || row.killed === 1) {
          continue;
        }
        if (labelFilters.length > 0) {
          continue;
        }
        seen.add(row.conversation_id);
        pushTracked(row.conversation_id);
      }
    }

    const tty = context.stdout.isTTY === true;
    const emit = (event: EventsEvent): void => {
      if (tty) {
        emitText(context.stdout, renderHuman(event, tracked));
        return;
      }
      context.stdout.write(`${JSON.stringify(event)}\n`);
    };

    return await new Promise<number>((resolve) => {
      const watchers: TranscriptWatcher[] = [];
      let stopped = false;

      const shutdown = (): void => {
        if (stopped) {
          return;
        }
        stopped = true;
        clearInterval(heartbeatTimer);
        for (const watcher of watchers) {
          watcher.close();
        }
        cleanupAbort();
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
          process.removeListener(signal, onSignal);
        }
        resolve(0);
      };

      const onSignal = (): void => {
        shutdown();
      };
      const onAbort = (): void => {
        shutdown();
      };
      const cleanupAbort = (): void => {
        options.abort?.removeEventListener("abort", onAbort);
      };
      options.abort?.addEventListener("abort", onAbort);
      if (options.abort === undefined) {
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
      }

      const heartbeatTimer = setInterval(() => {
        emit({ type: "heartbeat", at: new Date().toISOString() });
      }, heartbeatMs);

      for (const entry of tracked) {
        const watcher = new TranscriptWatcher({
          antigravityDir: paths.antigravityDir,
          conversationId: entry.conversationId,
          summariesDbPath: paths.summariesDbPath,
          debounceMs: 20,
          fallbackMs: 1000,
          onChange: () => {
            if (stopped) {
              return;
            }
            const fresh = observeConversation(paths, reader, entry.conversationId, store);
            for (const step of watcher.readNewSteps()) {
              emit({
                type: "step",
                conversationId: entry.conversationId,
                shortId: entry.shortId,
                stepIndex: step.step_index,
                stepType: step.type,
                stepStatus: step.status,
                at: new Date().toISOString(),
              });
            }
            if (fresh.status !== entry.status) {
              const wasSettled = SETTLED.has(entry.status);
              entry.status = fresh.status;
              emit({
                type: "state",
                conversationId: entry.conversationId,
                shortId: entry.shortId,
                name: entry.name,
                status: entry.status,
                at: new Date().toISOString(),
              });
              if (SETTLED.has(entry.status) && !wasSettled) {
                emit({
                  type: "terminal",
                  conversationId: entry.conversationId,
                  shortId: entry.shortId,
                  name: entry.name,
                  status: entry.status,
                  at: new Date().toISOString(),
                });
              }
            }
          },
        });
        watcher.start();
        watchers.push(watcher);
      }
    });
  } finally {
    reader?.close();
    store?.close();
  }
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

function renderHuman(event: EventsEvent, tracked: TrackedConversation[]): string {
  const time = event.at.slice(11, 19);
  const entry =
    event.conversationId === undefined
      ? undefined
      : tracked.find((item) => item.conversationId === event.conversationId);
  const label =
    entry === undefined
      ? ""
      : `${entry.shortId === null ? entry.conversationId.slice(0, 8) : `c${entry.shortId}`}`;
  switch (event.type) {
    case "heartbeat":
      return `${time} heartbeat`;
    case "step":
      return `${time} ${label} step ${event.stepIndex} ${event.stepType} ${event.stepStatus}`;
    case "state":
      return `${time} ${label} status ${event.status}`;
    case "terminal":
      return `${time} ${label} terminal ${event.status}`;
  }
}

function parseHeartbeat(raw: string | undefined): number {
  if (raw === undefined) {
    return 15_000;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new AgCliError("invalid_usage", `--heartbeat-ms expects a positive integer, got ${raw}`);
  }
  return value;
}
