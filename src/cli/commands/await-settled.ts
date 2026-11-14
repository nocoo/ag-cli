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

  return new Promise<SettleOutcome>((resolve) => {
    let finished = false;
    const watcher = new TranscriptWatcher({
      antigravityDir: options.paths.antigravityDir,
      conversationId: options.conversationId,
      summariesDbPath: options.paths.summariesDbPath,
      stateDbPath: options.paths.stateDbPath,
      debounceMs: 20,
      fallbackMs: 500,
      onChange: () => {
        tick();
      },
    });
    const check = (): ConversationStatus => {
      watcher.readNewSteps();
      return observeConversation(
        options.paths,
        options.reader,
        options.conversationId,
        options.store,
        watcher.currentSteps(),
      ).status;
    };
    const finish = (timedOut: boolean): void => {
      finished = true;
      clearTimeout(deadlineTimer);
      watcher.close();
      resolve({ status: check(), timedOut, durationMs: Date.now() - start });
    };
    const tick = (): void => {
      if (!finished && SETTLED.has(check())) {
        finish(false);
      }
    };
    const deadlineTimer = setTimeout(() => {
      finish(!SETTLED.has(check()));
    }, options.timeoutSec * 1000);
    watcher.start();
    tick();
  });
}
