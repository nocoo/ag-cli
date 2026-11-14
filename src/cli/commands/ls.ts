import { resolvePaths } from "../../infra/paths";
import { type ConversationSummaryRow, openSummariesReader } from "../../infra/summaries-reader";
import { emitJson, emitText, renderTable, resolveMode, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";
import { type ConversationObservation, observeConversation } from "./registry";

export interface LsRow {
  shortId: string;
  name: string;
  conversationId: string;
  status: string;
  turn: number;
  stepCount: number;
  title: string;
  project: string;
  updated: string;
}

function firstWorkspace(row: ConversationSummaryRow): string {
  if (row.workspace_uris === null) {
    return "";
  }
  try {
    const parsed = JSON.parse(row.workspace_uris) as unknown[];
    const first = parsed.find((entry) => typeof entry === "string") as string | undefined;
    return first === undefined ? "" : first.replace(/^file:\/\//, "");
  } catch {
    return "";
  }
}

export async function runLsCommand(
  args: string[],
  context: { env: Record<string, string | undefined>; stdout: StreamLike },
): Promise<number> {
  const flags = parseCommandFlags(args, { booleans: ["json", "all"], values: ["status"] });
  const paths = resolvePaths(context.env);
  const reader = openSummariesReader(paths.summariesDbPath);
  const rows = reader === null ? [] : reader.listConversations();

  const statusFilter = flags.values.get("status");
  const rowsOut: LsRow[] = [];
  try {
    for (const row of rows) {
      if (row.killed === 1 && !flags.flags.has("all")) {
        continue;
      }
      const observation = observeConversation(paths, reader, row.conversation_id);
      if (statusFilter !== undefined && observation.status !== statusFilter) {
        continue;
      }
      rowsOut.push(toLsRow(row, observation));
    }
  } finally {
    reader?.close();
  }

  const mode = resolveMode({
    json: flags.flags.has("json"),
    tty: context.stdout.isTTY === true,
    pipedIsJson: true,
  });
  if (mode === "json") {
    emitJson(context.stdout, rowsOut);
  } else {
    emitText(
      context.stdout,
      renderTable(
        ["SHORT", "NAME", "STATUS", "TURN", "STEPS", "TITLE", "PROJECT/CWD", "UPDATED"],
        rowsOut.map((row) => [
          row.shortId,
          row.name,
          row.status,
          String(row.turn),
          String(row.stepCount),
          row.title,
          row.project,
          row.updated,
        ]),
      ),
    );
  }
  return 0;
}

function toLsRow(row: ConversationSummaryRow, observation: ConversationObservation): LsRow {
  return {
    shortId: "-",
    name: "-",
    conversationId: row.conversation_id,
    status: observation.status,
    turn: observation.turns.length,
    stepCount: row.step_count,
    title: row.title ?? "",
    project: firstWorkspace(row),
    updated: row.last_modified_time ?? "",
  };
}
