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
  };
  return {
    conversationId,
    summary,
    managed,
    steps,
    turns: segmentTurns(steps),
    telemetry: aggregateTelemetry(steps),
    artifacts: listBrainArtifacts(paths.brainDir, conversationId),
    status: deriveConversationStatus(facts),
    watermarkStep,
  };
}

export function currentCallerId(env: Record<string, string | undefined>): string | undefined {
  return resolveCallerId(env);
}
