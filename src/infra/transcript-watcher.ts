import {
  closeSync,
  existsSync,
  type FSWatcher,
  openSync,
  readSync,
  statSync,
  watch,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseTranscriptText, type TranscriptStep } from "../domain/transcript-parser";

export type WatchChangeSource = "transcript" | "summaries";

export interface TranscriptWatcherOptions {
  antigravityDir: string;
  conversationId: string;
  summariesDbPath?: string;
  debounceMs?: number;
  fallbackMs?: number;
  onChange: (source: WatchChangeSource) => void;
}

interface IncrementalState {
  byteOffset: number;
  partial: string;
}

export class TranscriptWatcher {
  private readonly antigravityDir: string;
  private readonly conversationId: string;
  private readonly debounceMs: number;
  private readonly fallbackMs: number;
  private readonly transcriptPath: string;
  private readonly fullPath: string;
  private readonly summariesDbPath: string | undefined;
  private readonly onChange: (source: WatchChangeSource) => void;

  private transcriptState: IncrementalState = { byteOffset: 0, partial: "" };
  private fullState: IncrementalState = { byteOffset: 0, partial: "" };
  private watchers: FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private fallbackTimer: ReturnType<typeof setInterval> | undefined;
  private lastTranscriptStat = { size: -1, mtimeMs: -1 };
  private lastDataVersion: number | null = null;
  private summariesProbe: DatabaseSync | null = null;
  private closed = false;

  constructor(options: TranscriptWatcherOptions) {
    this.antigravityDir = options.antigravityDir;
    this.conversationId = options.conversationId;
    this.debounceMs = options.debounceMs ?? 20;
    this.fallbackMs = options.fallbackMs ?? 2000;
    this.summariesDbPath = options.summariesDbPath;
    this.onChange = options.onChange;
    const logsDir = join(
      options.antigravityDir,
      "brain",
      options.conversationId,
      ".system_generated",
      "logs",
    );
    this.transcriptPath = join(logsDir, "transcript.jsonl");
    this.fullPath = join(logsDir, "transcript_full.jsonl");
  }

  start(): void {
    if (this.closed) {
      return;
    }
    const conversationDir = join(this.antigravityDir, "brain", this.conversationId);
    const candidates = [
      join(conversationDir, ".system_generated", "logs"),
      conversationDir,
      join(this.antigravityDir, "brain"),
    ];
    const watched = new Set<string>();
    for (const dir of candidates) {
      if (watched.has(dir) || !existsSync(dir)) {
        continue;
      }
      watched.add(dir);
      try {
        this.watchers.push(
          watch(dir, () => {
            this.schedule();
          }),
        );
      } catch {
        // directory vanished between existsSync and watch; the fallback timer still covers it
      }
    }
    this.fallbackTimer = setInterval(() => {
      this.fallbackCheck();
    }, this.fallbackMs);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    if (this.fallbackTimer !== undefined) {
      clearInterval(this.fallbackTimer);
    }
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.summariesProbe?.close();
    this.summariesProbe = null;
  }

  private schedule(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.onChange("transcript");
    }, this.debounceMs);
  }

  private fallbackCheck(): void {
    if (existsSync(this.transcriptPath)) {
      const stats = statSync(this.transcriptPath);
      if (
        stats.size !== this.lastTranscriptStat.size ||
        stats.mtimeMs !== this.lastTranscriptStat.mtimeMs
      ) {
        this.lastTranscriptStat = { size: stats.size, mtimeMs: stats.mtimeMs };
        this.onChange("transcript");
        return;
      }
    }
    if (this.summariesDbPath !== undefined && existsSync(this.summariesDbPath)) {
      let dataVersion: number | null = null;
      try {
        if (this.summariesProbe === null) {
          const db = new DatabaseSync(this.summariesDbPath);
          db.exec("PRAGMA query_only = ON;");
          db.exec("PRAGMA busy_timeout = 3000;");
          this.summariesProbe = db;
        }
        const row = this.summariesProbe.prepare("PRAGMA data_version").get() as
          | {
              data_version?: number;
            }
          | undefined;
        dataVersion = row?.data_version ?? null;
      } catch {
        dataVersion = null;
      }
      if (dataVersion !== null) {
        if (this.lastDataVersion !== null && dataVersion !== this.lastDataVersion) {
          this.onChange("summaries");
        }
        this.lastDataVersion = dataVersion;
      }
    }
  }

  readNewSteps(): TranscriptStep[] {
    return this.readIncremental(this.transcriptPath, (state) => {
      this.transcriptState = state;
    });
  }

  readNewFullSteps(): TranscriptStep[] {
    return this.readIncremental(this.fullPath, (state) => {
      this.fullState = state;
    });
  }

  private readIncremental(
    path: string,
    replaceState: (state: IncrementalState) => void,
  ): TranscriptStep[] {
    const state = path === this.transcriptPath ? this.transcriptState : this.fullState;
    if (!existsSync(path)) {
      replaceState({ byteOffset: 0, partial: "" });
      return [];
    }
    const stats = statSync(path);
    if (stats.size < state.byteOffset) {
      state.byteOffset = 0;
      state.partial = "";
    }
    if (stats.size === state.byteOffset) {
      return [];
    }
    const fd = openSync(path, "r");
    try {
      const length = stats.size - state.byteOffset;
      const buffer = Buffer.alloc(length);
      const bytes = readSync(fd, buffer, 0, length, state.byteOffset);
      const chunk = state.partial + buffer.toString("utf8", 0, bytes);
      const lines = chunk.split("\n");
      const partial = lines.pop() ?? "";
      const nextState = {
        byteOffset: stats.size,
        partial,
      };
      replaceState(nextState);
      return parseTranscriptText(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
    } finally {
      closeSync(fd);
    }
  }
}
