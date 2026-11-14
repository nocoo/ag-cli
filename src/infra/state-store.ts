import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertAlias, assertUuid } from "../domain/validation";
import { AgCliError } from "../types/protocol";

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
  deliverySeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryTicket {
  seq: number;
  previousWatermark: number;
  createdRow: boolean;
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
    delivery_seq    INTEGER NOT NULL DEFAULT 0,
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
  CREATE TABLE IF NOT EXISTS name_reservations (
    name       TEXT PRIMARY KEY,
    token      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_id);
  CREATE INDEX IF NOT EXISTS idx_labels_kv ON labels(key, value);
`;

type RawRow = Record<string, unknown>;

function migrateDeliverySeq(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(conversations)").all() as unknown as RawRow[];
  if (!columns.some((column) => String(column.name) === "delivery_seq")) {
    db.exec("ALTER TABLE conversations ADD COLUMN delivery_seq INTEGER NOT NULL DEFAULT 0;");
  }
}

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
    deliverySeq: Number(raw.delivery_seq ?? 0),
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
    migrateDeliverySeq(db);
    return new StateStore(db);
  }

  pragma(name: string): unknown {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as RawRow | undefined;
    if (row === undefined) {
      return null;
    }
    return Object.values(row)[0] ?? null;
  }

  rawExec(sql: string, ...params: Array<string | number | null>): void {
    this.db.prepare(sql).run(...params);
  }

  beginDelivery(conversationId: string, watermarkStep: number): DeliveryTicket {
    assertUuid(conversationId);
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.db
        .prepare("SELECT watermark_step FROM conversations WHERE conversation_id = ?")
        .get(conversationId) as RawRow | undefined;
      const createdRow = existing === undefined;
      const previousWatermark = createdRow ? -1 : Number(existing.watermark_step);
      this.db
        .prepare(
          "INSERT INTO conversations (conversation_id, watermark_step, delivery_seq, created_at, updated_at)" +
            " VALUES (?, ?, 1, ?, ?)" +
            " ON CONFLICT(conversation_id) DO UPDATE SET" +
            " watermark_step = MAX(watermark_step, excluded.watermark_step)," +
            " delivery_seq = delivery_seq + 1," +
            " updated_at = excluded.updated_at",
        )
        .run(conversationId, watermarkStep, now, now);
      const row = this.db
        .prepare("SELECT delivery_seq FROM conversations WHERE conversation_id = ?")
        .get(conversationId) as RawRow;
      this.db.exec("COMMIT;");
      return { seq: Number(row.delivery_seq), previousWatermark, createdRow };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  rollbackDelivery(conversationId: string, ticket: DeliveryTicket): boolean {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.db
        .prepare("SELECT delivery_seq FROM conversations WHERE conversation_id = ?")
        .get(conversationId) as RawRow | undefined;
      if (row === undefined || Number(row.delivery_seq) !== ticket.seq) {
        this.db.exec("COMMIT;");
        return false;
      }
      if (
        ticket.createdRow &&
        ticket.seq === 1 &&
        Number(
          (
            this.db
              .prepare("SELECT COUNT(*) AS n FROM labels WHERE conversation_id = ?")
              .get(conversationId) as RawRow
          ).n,
        ) === 0
      ) {
        this.db.prepare("DELETE FROM conversations WHERE conversation_id = ?").run(conversationId);
      } else {
        this.db
          .prepare(
            "UPDATE conversations SET watermark_step = ?, updated_at = ? WHERE conversation_id = ?",
          )
          .run(ticket.previousWatermark, this.now(), conversationId);
      }
      this.db.exec("COMMIT;");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  acquireNameReservation(name: string, token: string): boolean {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const holder = this.db
        .prepare("SELECT token FROM name_reservations WHERE name = ?")
        .get(name) as RawRow | undefined;
      if (holder !== undefined) {
        this.db.exec("COMMIT;");
        return false;
      }
      this.db
        .prepare("INSERT INTO name_reservations (name, token, created_at) VALUES (?, ?, ?)")
        .run(name, token, this.now());
      this.db.exec("COMMIT;");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  releaseNameReservation(name: string, token: string): void {
    this.db.prepare("DELETE FROM name_reservations WHERE name = ? AND token = ?").run(name, token);
  }

  private now(): string {
    return new Date().toISOString();
  }

  registerConversation(conversationId: string, options: RegisterOptions): ManagedRow {
    assertUuid(conversationId);
    if (options.name !== undefined) {
      assertAlias(options.name);
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
    return row as ManagedRow;
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
    const parsed = pairs.map((pair) => {
      const separator = pair.indexOf("=");
      if (separator < 1) {
        throw new AgCliError("invalid_usage", `invalid label ${pair}`, {
          hint: "Use key=value or key= to remove.",
        });
      }
      return { key: pair.slice(0, separator), value: pair.slice(separator + 1) };
    });

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const entry of parsed) {
        if (entry.value.length === 0) {
          this.db
            .prepare("DELETE FROM labels WHERE conversation_id = ? AND key = ?")
            .run(conversationId, entry.key);
        } else {
          this.db
            .prepare(
              "INSERT INTO labels (conversation_id, key, value) VALUES (?, ?, ?)" +
                " ON CONFLICT(conversation_id, key) DO UPDATE SET value = excluded.value",
            )
            .run(conversationId, entry.key, entry.value);
        }
      }
      this.db
        .prepare(
          "UPDATE conversations SET delivery_seq = delivery_seq + 1, updated_at = ?" +
            " WHERE conversation_id = ?",
        )
        .run(this.now(), conversationId);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  releaseName(conversationId: string): void {
    this.db
      .prepare("UPDATE conversations SET name = NULL, updated_at = ? WHERE conversation_id = ?")
      .run(this.now(), conversationId);
  }

  setLastTurn(conversationId: string, turns: number): void {
    this.db
      .prepare("UPDATE conversations SET last_turn = ?, updated_at = ? WHERE conversation_id = ?")
      .run(turns, this.now(), conversationId);
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
      .prepare(
        "UPDATE conversations SET terminated = 1, name = NULL, updated_at = ? WHERE conversation_id = ?",
      )
      .run(this.now(), conversationId);
  }

  removeConversation(conversationId: string): void {
    this.db.prepare("DELETE FROM conversations WHERE conversation_id = ?").run(conversationId);
  }

  close(): void {
    this.db.close();
  }
}
