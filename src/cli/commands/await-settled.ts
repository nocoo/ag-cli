import { existsSync, type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import type { ResolvedPaths } from "../../infra/paths";
import type { StateStore } from "../../infra/state-store";
import type { SummariesReader } from "../../infra/summaries-reader";
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
  const deadline = start + options.timeoutSec * 1000;
  const check = (): ConversationStatus =>
    observeConversation(options.paths, options.reader, options.conversationId, options.store)
      .status;

  return new Promise<SettleOutcome>((resolve) => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const watchers: FSWatcher[] = [];

    const stop = (): void => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      clearInterval(interval);
      for (const watcher of watchers) {
        watcher.close();
      }
    };

    const finish = (timedOut: boolean): void => {
      stop();
      resolve({ status: check(), timedOut, durationMs: Date.now() - start });
    };

    const tick = (): void => {
      if (SETTLED.has(check())) {
        finish(false);
      } else if (Date.now() >= deadline) {
        finish(true);
      }
    };

    const watchTargets = [
      join(options.paths.brainDir, options.conversationId, ".system_generated", "logs"),
      join(options.paths.brainDir, options.conversationId),
      options.paths.brainDir,
    ];
    for (const dir of watchTargets) {
      if (existsSync(dir)) {
        watchers.push(
          watch(dir, () => {
            timers.push(setTimeout(tick, 20));
          }),
        );
      }
    }
    const interval = setInterval(tick, 500);
    tick();
  });
}
