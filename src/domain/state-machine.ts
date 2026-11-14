import type { ConversationStatus } from "../types/protocol";
import { hasPendingToolCalls, type TranscriptStep } from "./transcript-parser";

export interface StateFacts {
  summary?: {
    status: string;
    not_fully_idle: number;
    killed: number;
  };
  terminated?: number;
  watermarkStep: number;
  steps: TranscriptStep[];
  awaitingArtifactFeedback?: boolean;
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

function latestInboundIndex(steps: TranscriptStep[]): number {
  let index = -1;
  for (let position = 0; position < steps.length; position += 1) {
    const step = steps[position];
    if (step !== undefined && INBOUND_TYPES.has(step.type ?? "")) {
      index = position;
    }
  }
  return index;
}

function currentTurnSteps(steps: TranscriptStep[]): TranscriptStep[] {
  const inbound = latestInboundIndex(steps);
  return inbound === -1 ? [...steps] : steps.slice(inbound);
}

function hasUnansweredQuestion(step: TranscriptStep): boolean {
  return (step.tool_calls ?? []).some(
    (toolCall) => toolCall.name === "ask_question" && toolCall.status !== "DONE",
  );
}

function isBlockedTurn(steps: TranscriptStep[], awaitingArtifactFeedback: boolean): boolean {
  if (awaitingArtifactFeedback) {
    return true;
  }
  const turn = currentTurnSteps(steps);
  let pendingIndex = -1;
  for (let index = 0; index < turn.length; index += 1) {
    const step = turn[index];
    if (step === undefined) {
      continue;
    }
    if (step.status === "WAITING" || hasUnansweredQuestion(step)) {
      pendingIndex = index;
    }
  }
  if (pendingIndex === -1) {
    return false;
  }
  return !turn.slice(pendingIndex + 1).some((step) => step?.status === "DONE");
}

function inboundAtOrAfter(
  steps: TranscriptStep[],
  watermarkStep: number,
): TranscriptStep | undefined {
  let found: TranscriptStep | undefined;
  for (const step of steps) {
    if (INBOUND_TYPES.has(step.type ?? "") && step.step_index >= watermarkStep) {
      found = step;
    }
  }
  return found;
}

function stableReplyAfter(
  steps: TranscriptStep[],
  inbound: TranscriptStep,
): TranscriptStep | undefined {
  let reply: TranscriptStep | undefined;
  for (const step of steps) {
    if (step.step_index <= inbound.step_index) {
      continue;
    }
    if (step.type === "PLANNER_RESPONSE" && step.status === "DONE" && !hasPendingToolCalls(step)) {
      reply = step;
    }
  }
  return reply;
}

function unfinishedWorkAfter(steps: TranscriptStep[], reply: TranscriptStep): boolean {
  return steps.some((step) => {
    if (step.step_index <= reply.step_index) {
      return false;
    }
    if (step.status === "RUNNING") {
      return true;
    }
    return hasPendingToolCalls(step);
  });
}

export function deriveConversationStatus(facts: StateFacts): ConversationStatus {
  const { summary, terminated, watermarkStep, steps } = facts;

  if (summary?.killed === 1 || terminated === 1 || latestErrorWithoutRecovery(steps)) {
    return "error";
  }

  if (isBlockedTurn(steps, facts.awaitingArtifactFeedback === true)) {
    return "blocked";
  }

  const last = steps.at(-1);
  if (
    summary?.status === "CASCADE_RUN_STATUS_RUNNING" ||
    summary?.not_fully_idle === 1 ||
    last?.status === "RUNNING"
  ) {
    return "working";
  }

  if (watermarkStep >= 0) {
    const inbound = inboundAtOrAfter(steps, watermarkStep);
    if (inbound === undefined) {
      return "working";
    }
    const reply = stableReplyAfter(steps, inbound);
    if (reply === undefined) {
      return "working";
    }
    if (unfinishedWorkAfter(steps, reply)) {
      return "working";
    }
    if (summary === undefined || summary.status !== "CASCADE_RUN_STATUS_IDLE") {
      return summary === undefined ? "idle" : "working";
    }
    return "done";
  }

  if (
    summary !== undefined &&
    summary.status === "CASCADE_RUN_STATUS_IDLE" &&
    summary.not_fully_idle === 0
  ) {
    const inbound = latestInboundIndex(steps);
    if (inbound !== -1) {
      const inboundStep = steps[inbound] as TranscriptStep;
      const reply = stableReplyAfter(steps, inboundStep);
      if (reply !== undefined && !unfinishedWorkAfter(steps, reply)) {
        return "done";
      }
    }
  }

  return "idle";
}
