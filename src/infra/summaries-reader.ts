import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ConversationSummaryRow {
  conversation_id: string;
  title: string | null;
  preview: string | null;
  step_count: number;
  last_modified_time: string | null;
  workspace_uris: string | null;
  status: string;
  project_id: string | null;
  parent_conversation_id: string | null;
  nesting_depth: number;
  not_fully_idle: number;
  killed: number;
  last_user_input_step_index: number | null;
}

export interface BrainArtifact {
  name: string;
  path: string;
  bytes: number;
  modifiedAt: string;
}

type RawRow = Record<string, unknown>;

function toRow(raw: RawRow): ConversationSummaryRow {
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    conversation_id: String(raw.conversation_id),
    title: text(raw.title),
    preview: text(raw.preview),
    step_count: Number(raw.step_count),
    last_modified_time: text(raw.last_modified_time),
    workspace_uris: text(raw.workspace_uris),
    status: String(raw.status),
    project_id: text(raw.project_id),
    parent_conversation_id: text(raw.parent_conversation_id),
    nesting_depth: Number(raw.nesting_depth),
    not_fully_idle: Number(raw.not_fully_idle),
    killed: Number(raw.killed),
    last_user_input_step_index:
      raw.last_user_input_step_index === null || raw.last_user_input_step_index === undefined
        ? null
        : Number(raw.last_user_input_step_index),
  };
}

export class SummariesReader {
  private constructor(private readonly db: DatabaseSync) {}

  static open(dbPath: string): SummariesReader | null {
    if (!existsSync(dbPath)) {
      return null;
    }
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA query_only = ON;");
    db.exec("PRAGMA busy_timeout = 3000;");
    return new SummariesReader(db);
  }

  listConversations(): ConversationSummaryRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM conversation_summaries ORDER BY last_modified_time DESC, conversation_id DESC",
      )
      .all() as unknown as RawRow[];
    return rows.map(toRow);
  }

  getConversation(conversationId: string): ConversationSummaryRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM conversation_summaries WHERE conversation_id = ?")
      .get(conversationId) as unknown as RawRow | undefined;
    return row === undefined ? undefined : toRow(row);
  }

  close(): void {
    this.db.close();
  }
}

export function openSummariesReader(dbPath: string): SummariesReader | null {
  return SummariesReader.open(dbPath);
}

export function listBrainArtifacts(brainDir: string, conversationId: string): BrainArtifact[] {
  const conversationDir = join(brainDir, conversationId);
  if (!existsSync(conversationDir)) {
    return [];
  }
  return readdirSync(conversationDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(conversationDir, entry.name);
      const stats = statSync(path);
      return {
        name: entry.name,
        path,
        bytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
