import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveConversationStatus, type StateFacts } from "../../domain/state-machine";
import type { ManagedConversation, TargetRegistry } from "../../domain/target-resolver";
import {
  aggregateTelemetry,
  parseTranscriptText,
  segmentTurns,
  type TranscriptStep,
  type TranscriptTelemetry,
  type TranscriptTurn,
} from "../../domain/transcript-parser";
import { type ResolvedPaths, resolveCallerId } from "../../infra/paths";
import type { StateStore } from "../../infra/state-store";
import {
  type BrainArtifact,
  type ConversationSummaryRow,
  listBrainArtifacts,
  type SummariesReader,
} from "../../infra/summaries-reader";

const INBOUND_TYPES = new Set(["USER_INPUT", "SYSTEM_MESSAGE"]);

export interface ConversationObservation {
  conversationId: string;
  summary: ConversationSummaryRow | undefined;
  managed: ReturnType<StateStore["findByConversationId"]>;
  steps: TranscriptStep[];
  turns: TranscriptTurn[];
  telemetry: TranscriptTelemetry;
  artifacts: BrainArtifact[];
  status: ReturnType<typeof deriveConversationStatus>;
  watermarkStep: number;
}

export function collectBrainIds(brainDir: string): string[] {
  if (!existsSync(brainDir)) {
    return [];
  }
  return readdirSync(brainDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function loadTranscriptSteps(
  antigravityDir: string,
  conversationId: string,
): TranscriptStep[] {
  return parseTranscriptText(
    readTranscriptFile(antigravityDir, conversationId, "transcript.jsonl"),
  );
}

export function loadFullTranscriptSteps(
  antigravityDir: string,
  conversationId: string,
): TranscriptStep[] {
  return parseTranscriptText(
    readTranscriptFile(antigravityDir, conversationId, "transcript_full.jsonl"),
  );
}

function readTranscriptFile(antigravityDir: string, conversationId: string, file: string): string {
  const path = join(antigravityDir, "brain", conversationId, ".system_generated", "logs", file);
  if (!existsSync(path)) {
    return "";
  }
  return readFileSync(path, "utf8");
}

export function buildTargetRegistry(
  paths: ResolvedPaths,
  reader: SummariesReader | null,
  store: StateStore | null = null,
): TargetRegistry {
  const managed: ManagedConversation[] =
    store === null
      ? []
      : store.listManaged().map((row) => ({
          shortId: row.shortId,
          conversationId: row.conversationId,
          name: row.name,
          terminated: row.terminated,
        }));
  return {
    managed,
    summaryIds: reader === null ? [] : reader.listConversations().map((row) => row.conversation_id),
    brainIds: collectBrainIds(paths.brainDir),
  };
}

export function currentTurnAwaitingArtifactFeedback(steps: TranscriptStep[]): boolean {
  let latestInbound = -1;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step !== undefined && INBOUND_TYPES.has(step.type ?? "")) {
      latestInbound = index;
    }
  }
  if (latestInbound === -1) {
    return false;
  }
  return steps.slice(latestInbound + 1).some((step) =>
    (step?.tool_calls ?? []).some((toolCall) => {
      const args = toolCall.arguments as { RequestFeedback?: unknown } | null | undefined;
      return args?.RequestFeedback === true && toolCall.status !== "DONE";
    }),
  );
}

export function countCompletedTurns(turns: TranscriptTurn[]): number {
  return turns.filter((turn) =>
    turn.steps.some((step) => step.type === "PLANNER_RESPONSE" && step.status === "DONE"),
  ).length;
}

export function observeConversation(
  paths: ResolvedPaths,
  reader: SummariesReader | null,
  conversationId: string,
  store: StateStore | null = null,
  steps: TranscriptStep[] = loadTranscriptSteps(paths.antigravityDir, conversationId),
): ConversationObservation {
  const summary = reader?.getConversation(conversationId);
  const managed = store?.findByConversationId(conversationId) ?? undefined;
  const watermarkStep = managed?.watermarkStep ?? -1;
  const turns = segmentTurns(steps);
  const facts: StateFacts = {
    summary:
      summary === undefined
        ? undefined
        : {
            status: summary.status,
            not_fully_idle: summary.not_fully_idle,
            killed: summary.killed,
          },
    terminated: managed?.terminated ?? 0,
    watermarkStep,
    steps,
    awaitingArtifactFeedback: currentTurnAwaitingArtifactFeedback(steps),
  };
  const status = deriveConversationStatus(facts);
  const completedTurns = countCompletedTurns(turns);
  if (store !== null && managed !== undefined && completedTurns > managed.lastTurn) {
    try {
      store.setLastTurn(conversationId, completedTurns);
      managed.lastTurn = completedTurns;
    } catch {
      // best-effort bookkeeping: observation must never fail on a locked db
    }
  }
  return {
    conversationId,
    summary,
    managed,
    steps,
    turns,
    telemetry: aggregateTelemetry(steps),
    artifacts: listBrainArtifacts(paths.brainDir, conversationId),
    status,
    watermarkStep,
  };
}

export function currentCallerId(env: Record<string, string | undefined>): string | undefined {
  return resolveCallerId(env);
}
