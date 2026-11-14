import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  existsSync,
  type FSWatcher,
  openSync,
  readSync,
  statSync,
  watch,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { parseTranscriptText, type TranscriptStep } from "../domain/transcript-parser";

export type WatchChangeSource = "transcript" | "summaries" | "state";

export interface TranscriptWatcherOptions {
  antigravityDir: string;
  conversationId: string;
  summariesDbPath?: string;
  stateDbPath?: string;
  debounceMs?: number;
  fallbackMs?: number;
  onChange: (source: WatchChangeSource) => void;
}

interface FileCursor {
  byteOffset: number;
  partial: string;
  decoder: StringDecoder;
  inode: number | null;
  size: number;
  mtimeMs: number;
  hash: Hash;
  contentHash: string;
}

export class TranscriptWatcher {
  private readonly antigravityDir: string;
  private readonly conversationId: string;
  private readonly debounceMs: number;
  private readonly fallbackMs: number;
  private readonly transcriptPath: string;
  private readonly fullPath: string;
  private readonly summariesDbPath: string | undefined;
  private readonly stateDbPath: string | undefined;
  private readonly onChange: (source: WatchChangeSource) => void;

  private transcript: FileCursor = TranscriptWatcher.emptyCursor();
  private full: FileCursor = TranscriptWatcher.emptyCursor();
  private cachedSteps: TranscriptStep[] = [];
  private watchers: FSWatcher[] = [];
  private watchedDirs = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private fallbackTimer: ReturnType<typeof setInterval> | undefined;
  private lastTranscriptStat: { size: number; mtimeMs: number } = { size: -1, mtimeMs: -1 };
  private lastDataVersion: number | null = null;
  private lastStateMtime: number | null = null;
  private summariesProbe: DatabaseSync | null = null;
  private closed = false;

  constructor(options: TranscriptWatcherOptions) {
    this.antigravityDir = options.antigravityDir;
    this.conversationId = options.conversationId;
    this.debounceMs = options.debounceMs ?? 20;
    this.fallbackMs = options.fallbackMs ?? 2000;
    this.summariesDbPath = options.summariesDbPath;
    this.stateDbPath = options.stateDbPath;
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

  private static emptyCursor(): FileCursor {
    return {
      byteOffset: 0,
      partial: "",
      decoder: new StringDecoder("utf8"),
      inode: null,
      size: 0,
      mtimeMs: 0,
      hash: createHash("sha256"),
      contentHash: "",
    };
  }

  start(): void {
    if (this.closed) {
      return;
    }
    this.attachWatchDir(
      join(this.antigravityDir, "brain", this.conversationId, ".system_generated", "logs"),
    );
    this.attachWatchDir(join(this.antigravityDir, "brain", this.conversationId));
    this.attachWatchDir(join(this.antigravityDir, "brain"));
    if (this.summariesDbPath !== undefined) {
      this.attachWatchDir(dirname(this.summariesDbPath));
      this.primeSummariesBaseline();
    }
    if (this.stateDbPath !== undefined) {
      this.attachWatchDir(dirname(this.stateDbPath));
      this.primeStateBaseline();
    }
    this.primeTranscriptBaseline();
    this.fallbackTimer = setInterval(() => {
      this.fallbackCheck();
    }, this.fallbackMs);
  }

  private attachWatchDir(dir: string): void {
    if (this.watchedDirs.has(dir) || !existsSync(dir)) {
      return;
    }
    try {
      this.watchers.push(
        watch(dir, () => {
          this.schedule();
        }),
      );
      this.watchedDirs.add(dir);
    } catch {
      // directory vanished between existsSync and watch; the fallback timer still covers it
    }
  }

  private primeTranscriptBaseline(): void {
    if (!existsSync(this.transcriptPath)) {
      return;
    }
    const stats = statSync(this.transcriptPath);
    this.lastTranscriptStat = { size: stats.size, mtimeMs: stats.mtimeMs };
  }

  private primeSummariesBaseline(): void {
    this.lastDataVersion = this.readDataVersion();
  }

  private primeStateBaseline(): void {
    if (this.stateDbPath === undefined || !existsSync(this.stateDbPath)) {
      return;
    }
    this.lastStateMtime = statSync(this.stateDbPath).mtimeMs;
  }

  private readDataVersion(): number | null {
    if (this.closed) {
      return null;
    }
    if (this.summariesDbPath === undefined || !existsSync(this.summariesDbPath)) {
      return null;
    }
    try {
      if (this.summariesProbe === null) {
        const db = new DatabaseSync(this.summariesDbPath);
        db.exec("PRAGMA query_only = ON;");
        db.exec("PRAGMA busy_timeout = 3000;");
        this.summariesProbe = db;
      }
      const row = this.summariesProbe.prepare("PRAGMA data_version").get() as {
        data_version: number;
      };
      return row.data_version;
    } catch {
      return null;
    }
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
    this.watchedDirs.clear();
    this.summariesProbe?.close();
    this.summariesProbe = null;
  }

  private schedule(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (this.closed) {
        return;
      }
      this.onChange("transcript");
    }, this.debounceMs);
  }

  private fallbackCheck(): void {
    if (this.closed) {
      return;
    }
    let transcriptChanged = false;
    if (existsSync(this.transcriptPath)) {
      const stats = statSync(this.transcriptPath);
      if (
        stats.size !== this.lastTranscriptStat.size ||
        stats.mtimeMs !== this.lastTranscriptStat.mtimeMs
      ) {
        this.lastTranscriptStat = { size: stats.size, mtimeMs: stats.mtimeMs };
        transcriptChanged = true;
      }
    }
    if (transcriptChanged) {
      this.onChange("transcript");
      if (this.closed) {
        return;
      }
    }

    const dataVersion = this.readDataVersion();
    if (dataVersion !== null) {
      if (this.lastDataVersion !== null && dataVersion !== this.lastDataVersion) {
        this.onChange("summaries");
        if (this.closed) {
          return;
        }
      }
      this.lastDataVersion = dataVersion;
    }

    if (this.stateDbPath !== undefined && existsSync(this.stateDbPath)) {
      const mtimeMs = statSync(this.stateDbPath).mtimeMs;
      if (this.lastStateMtime !== null && mtimeMs !== this.lastStateMtime) {
        this.onChange("state");
        if (this.closed) {
          return;
        }
      }
      this.lastStateMtime = mtimeMs;
    }

    this.attachLateLogsDir();
  }

  private attachLateLogsDir(): void {
    if (this.closed) {
      return;
    }
    const logsDir = join(
      this.antigravityDir,
      "brain",
      this.conversationId,
      ".system_generated",
      "logs",
    );
    if (!this.watchedDirs.has(logsDir) && existsSync(logsDir)) {
      this.attachWatchDir(logsDir);
      this.onChange("transcript");
    }
  }

  readNewSteps(): TranscriptStep[] {
    const steps = this.readIncremental(
      this.transcriptPath,
      this.transcript,
      (cursor) => {
        this.transcript = cursor;
      },
      () => {
        this.cachedSteps = [];
      },
    );
    if (steps.length > 0) {
      this.cachedSteps = [...this.cachedSteps, ...steps];
    }
    return steps;
  }

  readNewFullSteps(): TranscriptStep[] {
    return this.readIncremental(
      this.fullPath,
      this.full,
      (cursor) => {
        this.full = cursor;
      },
      undefined,
    );
  }

  currentSteps(): TranscriptStep[] {
    return this.cachedSteps;
  }

  private static resetCursor(cursor: FileCursor): void {
    cursor.byteOffset = 0;
    cursor.partial = "";
    cursor.decoder = new StringDecoder("utf8");
    cursor.hash = createHash("sha256");
    cursor.contentHash = "";
  }

  private static hashPrefix(path: string, length: number): string {
    if (length <= 0) {
      return "";
    }
    const fd = openSync(path, "r");
    try {
      const hash = createHash("sha256");
      let offset = 0;
      while (offset < length) {
        const chunk = Math.min(64 * 1024, length - offset);
        const buffer = Buffer.alloc(chunk);
        const bytes = readSync(fd, buffer, 0, chunk, offset);
        if (bytes <= 0) {
          break;
        }
        hash.update(buffer.subarray(0, bytes));
        offset += bytes;
      }
      return hash.digest("hex");
    } finally {
      closeSync(fd);
    }
  }

  private readIncremental(
    path: string,
    cursor: FileCursor,
    replace: (cursor: FileCursor) => void,
    onRewrite?: () => void,
  ): TranscriptStep[] {
    if (!existsSync(path)) {
      TranscriptWatcher.resetCursor(cursor);
      onRewrite?.();
      replace(cursor);
      return [];
    }
    const stats = statSync(path);
    const onDiskPrefix = TranscriptWatcher.hashPrefix(
      path,
      Math.min(stats.size, cursor.byteOffset),
    );
    const rewritten =
      stats.size < cursor.byteOffset ||
      (cursor.inode !== null && stats.ino !== cursor.inode) ||
      onDiskPrefix !== cursor.contentHash;
    if (rewritten) {
      TranscriptWatcher.resetCursor(cursor);
      onRewrite?.();
      replace(cursor);
    }
    if (stats.size === cursor.byteOffset) {
      return [];
    }
    const fd = openSync(path, "r");
    try {
      let steps: TranscriptStep[] = [];
      let offset = cursor.byteOffset;
      while (offset < stats.size) {
        const length = Math.min(64 * 1024, stats.size - offset);
        const buffer = Buffer.alloc(length);
        const bytes = readSync(fd, buffer, 0, length, offset);
        if (bytes <= 0) {
          break;
        }
        offset += bytes;
        cursor.hash.update(buffer.subarray(0, bytes));
        const text = cursor.decoder.write(buffer.subarray(0, bytes));
        const chunk = cursor.partial + text;
        const lines = chunk.split("\n");
        cursor.partial = lines.pop() ?? "";
        const parsed = parseTranscriptText(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
        if (parsed.length > 0) {
          steps = [...steps, ...parsed];
        }
      }
      cursor.byteOffset = offset;
      cursor.inode = stats.ino;
      cursor.size = stats.size;
      cursor.mtimeMs = stats.mtimeMs;
      cursor.contentHash = cursor.hash.copy().digest("hex");
      replace(cursor);
      return steps;
    } finally {
      closeSync(fd);
    }
  }
}
