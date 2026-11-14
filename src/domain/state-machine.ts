import type { ConversationStatus } from "../types/protocol";
import { hasPendingToolCalls, maxStepIndex, type TranscriptStep } from "./transcript-parser";

export interface StateFacts {
  summary?: {
    status: string;
    not_fully_idle: number;
    killed: number;
  };
  terminated?: number;
  watermarkStep: number;
  steps: TranscriptStep[];
}

const INBOUND_TYPES = new Set(["USER_INPUT", "SYSTEM_MESSAGE"]);

function latestErrorWithoutRecovery(steps: TranscriptStep[]): boolean {
  let lastErrorIndex = -1;
  for (const step of steps) {
    if (step.status === "ERROR") {
      lastErrorIndex = step.step_index;
    }
  }
  if (lastErrorIndex === -1) {
    return false;
  }
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step === undefined || step.step_index <= lastErrorIndex) {
      break;
    }
    if (INBOUND_TYPES.has(step.type ?? "")) {
      return false;
    }
  }
  return true;
}

function isBlocked(steps: TranscriptStep[]): boolean {
  const last = steps.at(-1);
  if (last === undefined) {
    return false;
  }
  if (last.status === "WAITING") {
    return true;
  }
  return (last.tool_calls ?? []).some((toolCall) => toolCall.name === "ask_question");
}

function hasStableReplyAfterLastInbound(steps: TranscriptStep[]): boolean {
  let lastInboundPosition = -1;
  for (let index = 0; index < steps.length; index += 1) {
    if (INBOUND_TYPES.has(steps[index]?.type ?? "")) {
      lastInboundPosition = index;
    }
  }
  if (lastInboundPosition === -1) {
    return false;
  }
  for (let index = lastInboundPosition + 1; index < steps.length; index += 1) {
    const step = steps[index];
    if (
      step !== undefined &&
      step.type === "PLANNER_RESPONSE" &&
      step.status === "DONE" &&
      !hasPendingToolCalls(step)
    ) {
      return true;
    }
  }
  return false;
}

export function deriveConversationStatus(facts: StateFacts): ConversationStatus {
  const { summary, terminated, watermarkStep, steps } = facts;
  const last = steps.at(-1);

  if (summary?.killed === 1 || terminated === 1 || latestErrorWithoutRecovery(steps)) {
    return "error";
  }

  if (isBlocked(steps)) {
    return "blocked";
  }

  if (
    summary?.status === "CASCADE_RUN_STATUS_RUNNING" ||
    summary?.not_fully_idle === 1 ||
    last?.status === "RUNNING" ||
    maxStepIndex(steps) < watermarkStep
  ) {
    return "working";
  }

  if (
    summary !== undefined &&
    summary.status === "CASCADE_RUN_STATUS_IDLE" &&
    summary.not_fully_idle === 0 &&
    maxStepIndex(steps) >= watermarkStep &&
    hasStableReplyAfterLastInbound(steps)
  ) {
    return "done";
  }

  return "idle";
}
