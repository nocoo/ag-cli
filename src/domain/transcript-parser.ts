export interface ToolCall {
  name?: string;
  status?: string;
  arguments?: unknown;
}

export interface TranscriptStep {
  step_index: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string | null;
  tool_calls?: ToolCall[];
  input_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
  truncated_fields?: string[];
}

export interface TranscriptTurn {
  inboundStepIndex: number;
  inboundType: "USER_INPUT" | "SYSTEM_MESSAGE";
  steps: TranscriptStep[];
}

export interface TranscriptTelemetry {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  stepCount: number;
}

const INBOUND_TYPES = new Set(["USER_INPUT", "SYSTEM_MESSAGE"]);

export function parseTranscriptLine(line: string): TranscriptStep | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.step_index !== "number" || !Number.isInteger(candidate.step_index)) {
    return null;
  }
  return candidate as unknown as TranscriptStep;
}

export function parseTranscriptText(text: string): TranscriptStep[] {
  const lines = text.split("\n");
  const steps: TranscriptStep[] = [];
  const completeLines = text.endsWith("\n") ? lines : lines.slice(0, -1);
  for (const line of completeLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const step = parseTranscriptLine(trimmed);
    if (step !== null) {
      steps.push(step);
    }
  }
  return steps;
}

export function segmentTurns(steps: TranscriptStep[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  for (const step of steps) {
    if (INBOUND_TYPES.has(step.type ?? "")) {
      current = {
        inboundStepIndex: step.step_index,
        inboundType: step.type as "USER_INPUT" | "SYSTEM_MESSAGE",
        steps: [step],
      };
      turns.push(current);
      continue;
    }
    if (current !== null) {
      current.steps.push(step);
    }
  }
  return turns;
}

function sum(
  steps: TranscriptStep[],
  field: "input_tokens" | "cache_read_tokens" | "output_tokens",
): number {
  return steps.reduce((total, step) => total + (step[field] ?? 0), 0);
}

export function aggregateTelemetry(steps: TranscriptStep[]): TranscriptTelemetry {
  return {
    inputTokens: sum(steps, "input_tokens"),
    cacheReadTokens: sum(steps, "cache_read_tokens"),
    outputTokens: sum(steps, "output_tokens"),
    stepCount: steps.length,
  };
}

export function mergeFullSteps(
  steps: TranscriptStep[],
  fullSteps: TranscriptStep[],
): TranscriptStep[] {
  const fullByIndex = new Map(fullSteps.map((full) => [full.step_index, full]));
  return steps.map((step) => {
    const truncated = step.truncated_fields ?? [];
    if (truncated.length === 0) {
      return step;
    }
    const full = fullByIndex.get(step.step_index);
    if (full === undefined) {
      return step;
    }
    const merged: TranscriptStep = { ...step };
    const fullRecord = full as unknown as Record<string, unknown>;
    const mergedRecord = merged as unknown as Record<string, unknown>;
    for (const field of truncated) {
      if (field in fullRecord) {
        mergedRecord[field] = fullRecord[field];
      }
    }
    return merged;
  });
}

export function maxStepIndex(steps: TranscriptStep[]): number {
  return steps.reduce((max, step) => Math.max(max, step.step_index), -1);
}

export function hasPendingToolCalls(step: TranscriptStep): boolean {
  return (step.tool_calls ?? []).some(
    (toolCall) => typeof toolCall.status === "string" && toolCall.status !== "DONE",
  );
}

export function latestReply(steps: TranscriptStep[]): TranscriptStep | undefined {
  let reply: TranscriptStep | undefined;
  for (const step of steps) {
    if (step.type === "PLANNER_RESPONSE" && step.status === "DONE" && !hasPendingToolCalls(step)) {
      reply = step;
    }
  }
  return reply;
}
