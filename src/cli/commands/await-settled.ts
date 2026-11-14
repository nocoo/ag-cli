import type { ResolvedPaths } from "../../infra/paths";
import type { StateStore } from "../../infra/state-store";
import type { SummariesReader } from "../../infra/summaries-reader";
import { TranscriptWatcher } from "../../infra/transcript-watcher";
import type { ConversationStatus } from "../../types/protocol";
import { countCompletedTurns, observeConversation } from "./registry";

export interface SettleOutcome {
  status: ConversationStatus;
  timedOut: boolean;
  durationMs: number;
}

const SETTLED = new Set<ConversationStatus>(["done", "blocked", "error"]);

export async function awaitSettledStatus(options: {
  paths: ResolvedPaths;
  reader: SummariesReader | null;
  store: StateStore | null;
  conversationId: string;
  timeoutSec: number;
}): Promise<SettleOutcome> {
  const start = Date.now();

  return new Promise<SettleOutcome>((resolve, reject) => {
    let stopped = false;
    let settled = false;
    const watcher = new TranscriptWatcher({
      antigravityDir: options.paths.antigravityDir,
      conversationId: options.conversationId,
      summariesDbPath: options.paths.summariesDbPath,
      stateDbPath: options.paths.stateDbPath,
      debounceMs: 20,
      fallbackMs: 500,
      onChange: () => {
        guarded(tick);
      },
    });

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const observation = () =>
      observeConversation(
        options.paths,
        options.reader,
        options.conversationId,
        options.store,
        watcher.currentSteps(),
      );

    const status = (): ConversationStatus => {
      watcher.readNewSteps();
      return observation().status;
    };

    const cleanup = (): void => {
      stopped = true;
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      watcher.close();
    };

    const settle = (settleFn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      settleFn();
    };

    const finish = (timedOut: boolean): void => {
      if (stopped || settled) {
        return;
      }
      cleanup();
      try {
        const fresh = observation();
        if (fresh.status === "done" && options.store !== null) {
          const turns = countCompletedTurns(fresh.turns);
          const managed = options.store.findByConversationId(options.conversationId);
          if (managed !== undefined && turns > managed.lastTurn) {
            options.store.setLastTurn(options.conversationId, turns);
          }
        }
        settle(() => resolve({ status: fresh.status, timedOut, durationMs: Date.now() - start }));
      } catch (error) {
        settle(() => reject(error));
      }
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      if (!stopped) {
        cleanup();
      }
      settle(() => reject(error));
    };

    const guarded = (action: () => void): void => {
      try {
        action();
      } catch (error) {
        fail(error);
      }
    };

    const tick = (): void => {
      if (!stopped && !settled && SETTLED.has(status())) {
        finish(false);
      }
    };

    watcher.start();
    if (options.timeoutSec > 0) {
      deadlineTimer = setTimeout(() => {
        guarded(() => {
          finish(!SETTLED.has(status()));
        });
      }, options.timeoutSec * 1000);
    }
    guarded(tick);
  });
}
