import { describe, expect, it } from "vitest";
import { deriveConversationStatus, type StateFacts } from "../../src/domain/state-machine";
import type { TranscriptStep } from "../../src/domain/transcript-parser";

function step(overrides: Partial<TranscriptStep> & { step_index: number }): TranscriptStep {
  return {
    source: "PLANNER",
    type: "GENERIC",
    status: "DONE",
    content: "",
    thinking: null,
    tool_calls: [],
    truncated_fields: [],
    ...overrides,
  };
}

function facts(partial: Partial<StateFacts> = {}): StateFacts {
  return {
    watermarkStep: -1,
    steps: [],
    ...partial,
  };
}

const IDLE = { status: "CASCADE_RUN_STATUS_IDLE", not_fully_idle: 0, killed: 0 };
const RUNNING = { status: "CASCADE_RUN_STATUS_RUNNING", not_fully_idle: 0, killed: 0 };

describe("priority 1: error (docs/03 §2)", () => {
  it("derives error when summaries reports killed", () => {
    expect(
      deriveConversationStatus(
        facts({ summary: { ...IDLE, killed: 1 }, steps: [step({ step_index: 0 })] }),
      ),
    ).toBe("error");
  });

  it("derives error when ag-cli marked the conversation terminated", () => {
    expect(
      deriveConversationStatus(
        facts({ summary: IDLE, terminated: 1, steps: [step({ step_index: 0 })] }),
      ),
    ).toBe("error");
  });

  it("derives error when the latest turn ended with an ERROR step", () => {
    const steps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      step({ step_index: 1, status: "ERROR", content: "boom" }),
    ];
    expect(deriveConversationStatus(facts({ summary: IDLE, steps }))).toBe("error");
  });

  it("recovers from an ERROR step once a new inbound message follows", () => {
    const steps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      step({ step_index: 1, status: "ERROR", content: "boom" }),
      step({ step_index: 2, type: "USER_INPUT" }),
      step({ step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", content: "recovered" }),
    ];
    expect(deriveConversationStatus(facts({ summary: IDLE, steps }))).toBe("done");
  });

  it("keeps error priority over blocked and working facts", () => {
    const steps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      step({ step_index: 1, status: "WAITING" }),
      step({ step_index: 2, status: "ERROR" }),
    ];
    expect(deriveConversationStatus(facts({ summary: RUNNING, steps }))).toBe("error");
  });
});

describe("priority 2: blocked (docs/03 §2)", () => {
  it("derives blocked when the last step is WAITING", () => {
    const steps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      step({ step_index: 1, status: "WAITING" }),
    ];
    expect(deriveConversationStatus(facts({ summary: RUNNING, steps }))).toBe("blocked");
  });

  it("derives blocked when the last step asks a question", () => {
    const steps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      step({
        step_index: 1,
        status: "DONE",
        tool_calls: [{ name: "ask_question", status: "WAITING" }],
      }),
    ];
    expect(deriveConversationStatus(facts({ summary: RUNNING, steps }))).toBe("blocked");
  });

  it("keeps blocked priority over working summaries", () => {
    const steps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      step({ step_index: 1, status: "WAITING" }),
    ];
    expect(
      deriveConversationStatus(facts({ summary: { ...RUNNING, not_fully_idle: 1 }, steps })),
    ).toBe("blocked");
  });
});

describe("priority 3: working (docs/03 §2)", () => {
  it("derives working when summaries reports RUNNING", () => {
    expect(deriveConversationStatus(facts({ summary: RUNNING }))).toBe("working");
  });

  it("derives working when not_fully_idle is set", () => {
    expect(deriveConversationStatus(facts({ summary: { ...IDLE, not_fully_idle: 1 } }))).toBe(
      "working",
    );
  });

  it("derives working when the transcript tail step is RUNNING", () => {
    const steps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      step({ step_index: 1, status: "RUNNING" }),
    ];
    expect(deriveConversationStatus(facts({ summary: IDLE, steps }))).toBe("working");
  });

  it("derives working when the delivery watermark is not reached yet", () => {
    const steps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      step({ step_index: 5, type: "PLANNER_RESPONSE", status: "DONE" }),
    ];
    expect(deriveConversationStatus(facts({ summary: IDLE, steps, watermarkStep: 6 }))).toBe(
      "working",
    );
  });
});

describe("priority 4: done (docs/03 §2)", () => {
  const doneSteps = [
    step({ step_index: 0, type: "USER_INPUT" }),
    step({ step_index: 1, type: "GENERIC", tool_calls: [{ name: "read_file", status: "DONE" }] }),
    step({ step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", content: "finished" }),
  ];

  it("derives done when idle, watermark satisfied and a stable planner reply follows the inbound", () => {
    expect(
      deriveConversationStatus(facts({ summary: IDLE, steps: doneSteps, watermarkStep: 0 })),
    ).toBe("done");
  });

  it("derives done for a second turn past an advanced watermark", () => {
    const steps = [
      ...doneSteps,
      step({ step_index: 3, type: "USER_INPUT" }),
      step({ step_index: 4, type: "PLANNER_RESPONSE", status: "DONE", content: "turn 2" }),
    ];
    expect(deriveConversationStatus(facts({ summary: IDLE, steps, watermarkStep: 3 }))).toBe(
      "done",
    );
  });

  it("does not derive done without a summaries row", () => {
    expect(deriveConversationStatus(facts({ steps: doneSteps, watermarkStep: 0 }))).toBe("idle");
  });

  it("does not derive done while not_fully_idle is set", () => {
    expect(
      deriveConversationStatus(
        facts({ summary: { ...IDLE, not_fully_idle: 1 }, steps: doneSteps }),
      ),
    ).toBe("working");
  });

  it("does not derive done when the planner reply still has pending tool calls", () => {
    const steps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      step({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [{ name: "run_command", status: "RUNNING" }],
      }),
    ];
    expect(deriveConversationStatus(facts({ summary: IDLE, steps }))).toBe("idle");
  });

  it("does not derive done when no inbound message precedes the planner reply", () => {
    const steps = [step({ step_index: 0, type: "PLANNER_RESPONSE", status: "DONE" })];
    expect(deriveConversationStatus(facts({ summary: IDLE, steps }))).toBe("idle");
  });
});

describe("priority 5: idle (docs/03 §2)", () => {
  it("derives idle for a fresh conversation without steps", () => {
    expect(deriveConversationStatus(facts({ summary: IDLE, watermarkStep: -1 }))).toBe("idle");
  });

  it("derives idle without any observed facts", () => {
    expect(deriveConversationStatus(facts())).toBe("idle");
  });

  it("treats typeless steps after an error as non-recovering", () => {
    const steps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      step({ step_index: 1, status: "ERROR" }),
      { step_index: 2 } as TranscriptStep,
    ];
    expect(deriveConversationStatus(facts({ summary: IDLE, steps }))).toBe("error");
  });

  it("treats typeless steps as non-inbound in error recovery and reply scans", () => {
    const errorSteps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      { step_index: 1, status: "ERROR" } as TranscriptStep,
    ];
    expect(deriveConversationStatus(facts({ summary: IDLE, steps: errorSteps }))).toBe("error");

    const doneSteps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      { step_index: 1 } as TranscriptStep,
      step({ step_index: 2, type: "PLANNER_RESPONSE", status: "DONE" }),
    ];
    expect(
      deriveConversationStatus(facts({ summary: IDLE, steps: doneSteps, watermarkStep: 0 })),
    ).toBe("done");
  });

  it("treats an unreached watermark 0 on an empty transcript as working (delivery race)", () => {
    expect(deriveConversationStatus(facts({ summary: IDLE, watermarkStep: 0 }))).toBe("working");
  });
});
