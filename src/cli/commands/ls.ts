import { resolvePaths } from "../../infra/paths";
import { StateStore } from "../../infra/state-store";
import { type ConversationSummaryRow, openSummariesReader } from "../../infra/summaries-reader";
import { NullgError } from "../../types/protocol";
import { emitJson, emitText, renderTable, resolveMode, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";
import { type ConversationObservation, currentCallerId, observeConversation } from "./registry";

export interface LsRow {
  shortId: string | null;
  name: string | null;
  conversationId: string;
  status: string;
  turn: number;
  stepCount: number;
  title: string;
  project: string;
  updated: string;
  labels: Record<string, string>;
  terminated: boolean;
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
  const flags = parseCommandFlags(args, {
    booleans: ["json", "all", "children"],
    values: ["status"],
    repeatables: ["label"],
  });
  if (flags.positionals.length !== 0) {
    throw new NullgError("invalid_usage", "ls takes no positional arguments");
  }
  const paths = resolvePaths(context.env);
  const reader = openSummariesReader(paths.summariesDbPath);
  const store = StateStore.open(paths.stateDbPath);
  try {
    const showAll = flags.flags.has("all");
    const allManaged = store?.listManaged() ?? [];
    const managedRows = showAll ? allManaged : allManaged.filter((row) => row.terminated === 0);
    const summaryRows = reader === null ? [] : reader.listConversations();
    const seen = new Set<string>(allManaged.map((row) => row.conversationId));
    const terminatedIds = new Set(
      allManaged.filter((row) => row.terminated === 1).map((row) => row.conversationId),
    );
    const candidates: Array<{ conversationId: string; summary?: ConversationSummaryRow }> = [];
    for (const row of managedRows) {
      seen.add(row.conversationId);
      candidates.push({
        conversationId: row.conversationId,
        summary: summaryRows.find((entry) => entry.conversation_id === row.conversationId),
      });
    }
    for (const row of summaryRows) {
      if (seen.has(row.conversation_id)) {
        continue;
      }
      if (!showAll && (row.killed === 1 || terminatedIds.has(row.conversation_id))) {
        continue;
      }
      candidates.push({ conversationId: row.conversation_id, summary: row });
    }

    const labelFilters = flags.repeatable.get("label") ?? [];
    for (const pair of labelFilters) {
      if (pair.indexOf("=") < 1) {
        throw new NullgError("invalid_usage", `invalid --label ${pair}`, {
          hint: "Use --label key=value.",
        });
      }
    }

    const callerId = flags.flags.has("children") ? currentCallerId(context.env) : undefined;
    if (flags.flags.has("children") && callerId === undefined) {
      throw new NullgError(
        "invalid_usage",
        "missing_target: --children needs a caller conversation",
        {
          hint: "Run inside an Antigravity conversation or set NULLG_CALLER_ID.",
        },
      );
    }

    const statusFilter = flags.values.get("status");
    if (
      statusFilter !== undefined &&
      !["idle", "working", "done", "blocked", "error"].includes(statusFilter)
    ) {
      throw new NullgError(
        "invalid_usage",
        `--status expects idle|working|done|blocked|error, got ${statusFilter}`,
      );
    }
    const rowsOut: LsRow[] = [];
    for (const candidate of candidates) {
      const observation = observeConversation(paths, reader, candidate.conversationId, store);
      if (statusFilter !== undefined && observation.status !== statusFilter) {
        continue;
      }
      const labels = Object.fromEntries(
        (store?.listLabels(candidate.conversationId) ?? []).map((label) => [
          label.key,
          label.value,
        ]),
      );
      if (
        !labelFilters.every((pair) => {
          const separator = pair.indexOf("=");
          return labels[pair.slice(0, separator)] === pair.slice(separator + 1);
        })
      ) {
        continue;
      }
      if (
        callerId !== undefined &&
        observation.managed?.parentId !== callerId &&
        candidate.summary?.parent_conversation_id !== callerId
      ) {
        continue;
      }
      rowsOut.push(toLsRow(candidate, observation, labels));
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
            row.shortId ?? "-",
            row.name ?? "-",
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
  } finally {
    reader?.close();
    store?.close();
  }
}

function toLsRow(
  candidate: { conversationId: string; summary?: ConversationSummaryRow },
  observation: ConversationObservation,
  labels: Record<string, string>,
): LsRow {
  const managed = observation.managed;
  const steps = observation.telemetry.stepCount;
  const summarySteps = candidate.summary?.step_count ?? 0;
  const workspace = candidate.summary === undefined ? "" : firstWorkspace(candidate.summary);
  return {
    shortId: managed === undefined ? null : `c${managed.shortId}`,
    name: managed?.name ?? null,
    conversationId: candidate.conversationId,
    status: observation.status,
    turn: observation.turns.length,
    stepCount: steps > 0 ? steps : summarySteps,
    title: candidate.summary?.title ?? "",
    project: workspace.length > 0 ? workspace : (managed?.cwd ?? ""),
    updated: managed?.updatedAt ?? candidate.summary?.last_modified_time ?? "",
    labels,
    terminated: managed?.terminated === 1,
  };
}
