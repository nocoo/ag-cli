import type { ResolvedPaths } from "../../infra/paths";
import type { StateStore } from "../../infra/state-store";
import type { SummariesReader } from "../../infra/summaries-reader";
import { TranscriptWatcher } from "../../infra/transcript-watcher";
import type { ConversationStatus } from "../../types/protocol";
import { observeConversation } from "./registry";

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
    let finished = false;
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
      finished = true;
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      watcher.close();
    };

    const finish = (timedOut: boolean): void => {
      if (finished) {
        return;
      }
      cleanup();
      const fresh = observation();
      if (fresh.status === "done" && options.store !== null) {
        const turns = fresh.turns.length;
        const managed = options.store.findByConversationId(options.conversationId);
        if (managed !== undefined && turns > managed.lastTurn) {
          options.store.setLastTurn(options.conversationId, turns);
        }
      }
      resolve({ status: fresh.status, timedOut, durationMs: Date.now() - start });
    };

    const fail = (error: unknown): void => {
      if (finished) {
        return;
      }
      cleanup();
      reject(error);
    };

    const guarded = (action: () => void): void => {
      try {
        action();
      } catch (error) {
        fail(error);
      }
    };

    const tick = (): void => {
      if (!finished && SETTLED.has(status())) {
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
