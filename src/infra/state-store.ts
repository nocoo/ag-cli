import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgCliError } from "../types/protocol";

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface ManagedRow {
  shortId: number;
  conversationId: string;
  name: string | null;
  parentId: string | null;
  cwd: string | null;
  projectId: string | null;
  model: string | null;
  watermarkStep: number;
  lastTurn: number;
  terminated: number;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterOptions {
  name?: string;
  parentId?: string;
  cwd?: string;
  projectId?: string;
  model?: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    short_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL UNIQUE,
    name            TEXT UNIQUE,
    parent_id       TEXT,
    cwd             TEXT,
    project_id      TEXT,
    model           TEXT,
    watermark_step  INTEGER NOT NULL DEFAULT -1,
    last_turn       INTEGER NOT NULL DEFAULT 0,
    terminated      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS labels (
    conversation_id TEXT NOT NULL,
    key             TEXT NOT NULL,
    value           TEXT NOT NULL,
    PRIMARY KEY (conversation_id, key),
    FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_id);
  CREATE INDEX IF NOT EXISTS idx_labels_kv ON labels(key, value);
`;

type RawRow = Record<string, unknown>;

function toRow(raw: RawRow): ManagedRow {
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    shortId: Number(raw.short_id),
    conversationId: String(raw.conversation_id),
    name: text(raw.name),
    parentId: text(raw.parent_id),
    cwd: text(raw.cwd),
    projectId: text(raw.project_id),
    model: text(raw.model),
    watermarkStep: Number(raw.watermark_step),
    lastTurn: Number(raw.last_turn),
    terminated: Number(raw.terminated),
    createdAt: String(raw.created_at),
    updatedAt: String(raw.updated_at),
  };
}

export class StateStore {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): StateStore | null;
  static open(path: string, options: { create: true }): StateStore;
  static open(path: string, options: { create?: boolean } = {}): StateStore | null {
    if (!options.create && !existsSync(path)) {
      return null;
    }
    if (options.create) {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 3000;");
    db.exec(SCHEMA);
    return new StateStore(db);
  }

  pragma(name: string): unknown {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as RawRow | undefined;
    if (row === undefined) {
      return null;
    }
    const values = Object.values(row);
    return values.length === 1 ? values[0] : (row[name] ?? null);
  }

  rawExec(sql: string, ...params: Array<string | number | null>): void {
    this.db.prepare(sql).run(...params);
  }

  private now(): string {
    return new Date().toISOString();
  }

  registerConversation(conversationId: string, options: RegisterOptions): ManagedRow {
    if (options.name !== undefined && !NAME_RE.test(options.name)) {
      throw new AgCliError("invalid_usage", `invalid name ${options.name}`, {
        hint: "Names match ^[a-z0-9][a-z0-9_-]{0,31}$.",
      });
    }
    if (options.name !== undefined) {
      const holder = this.db
        .prepare("SELECT conversation_id FROM conversations WHERE name = ?")
        .get(options.name) as RawRow | undefined;
      if (holder !== undefined && String(holder.conversation_id) !== conversationId) {
        throw new AgCliError("name_conflict", `name ${options.name} is already in use`, {
          hint: "Pick another name, use --reuse, or ag-cli rm the old conversation.",
        });
      }
    }
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO conversations (conversation_id, name, parent_id, cwd, project_id, model, created_at, updated_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?)" +
          " ON CONFLICT(conversation_id) DO NOTHING",
      )
      .run(
        conversationId,
        options.name ?? null,
        options.parentId ?? null,
        options.cwd ?? null,
        options.projectId ?? null,
        options.model ?? null,
        now,
        now,
      );
    const row = this.findByConversationId(conversationId);
    if (row === undefined) {
      throw new AgCliError("runtime_error", `failed to register conversation ${conversationId}`);
    }
    return row;
  }

  ensureConversation(conversationId: string, options: RegisterOptions = {}): ManagedRow {
    const existing = this.findByConversationId(conversationId);
    if (existing !== undefined) {
      return existing;
    }
    return this.registerConversation(conversationId, options);
  }

  findByConversationId(conversationId: string): ManagedRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE conversation_id = ?")
      .get(conversationId) as unknown as RawRow | undefined;
    return row === undefined ? undefined : toRow(row);
  }

  findActiveByName(name: string): ManagedRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE name = ? AND terminated = 0")
      .get(name) as unknown as RawRow | undefined;
    return row === undefined ? undefined : toRow(row);
  }

  listManaged(options: { activeOnly?: boolean } = {}): ManagedRow[] {
    const sql = options.activeOnly
      ? "SELECT * FROM conversations WHERE terminated = 0 ORDER BY short_id"
      : "SELECT * FROM conversations ORDER BY short_id";
    const rows = this.db.prepare(sql).all() as unknown as RawRow[];
    return rows.map(toRow);
  }

  listLabels(conversationId: string): Array<{ key: string; value: string }> {
    const rows = this.db
      .prepare("SELECT key, value FROM labels WHERE conversation_id = ? ORDER BY key")
      .all(conversationId) as unknown as RawRow[];
    return rows.map((row) => ({ key: String(row.key), value: String(row.value) }));
  }

  setLabels(conversationId: string, pairs: string[]): void {
    if (this.findByConversationId(conversationId) === undefined) {
      throw new AgCliError("not_found", `conversation ${conversationId} is not managed by ag-cli`);
    }
    for (const pair of pairs) {
      const separator = pair.indexOf("=");
      if (separator < 1) {
        throw new AgCliError("invalid_usage", `invalid label ${pair}`, {
          hint: "Use key=value or key= to remove.",
        });
      }
      const key = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (key.length === 0) {
        throw new AgCliError("invalid_usage", `invalid label ${pair}`);
      }
      if (value.length === 0) {
        this.db
          .prepare("DELETE FROM labels WHERE conversation_id = ? AND key = ?")
          .run(conversationId, key);
      } else {
        this.db
          .prepare(
            "INSERT INTO labels (conversation_id, key, value) VALUES (?, ?, ?)" +
              " ON CONFLICT(conversation_id, key) DO UPDATE SET value = excluded.value",
          )
          .run(conversationId, key, value);
      }
    }
  }

  updateWatermark(conversationId: string, watermarkStep: number): void {
    this.db
      .prepare(
        "UPDATE conversations SET watermark_step = ?, updated_at = ? WHERE conversation_id = ?",
      )
      .run(watermarkStep, this.now(), conversationId);
  }

  advanceTurn(conversationId: string): void {
    this.db
      .prepare(
        "UPDATE conversations SET last_turn = last_turn + 1, updated_at = ? WHERE conversation_id = ?",
      )
      .run(this.now(), conversationId);
  }

  markTerminated(conversationId: string): void {
    this.db
      .prepare("UPDATE conversations SET terminated = 1, updated_at = ? WHERE conversation_id = ?")
      .run(this.now(), conversationId);
  }

  removeConversation(conversationId: string): void {
    this.db.prepare("DELETE FROM conversations WHERE conversation_id = ?").run(conversationId);
  }

  close(): void {
    this.db.close();
  }
}
