import { describe, expect, it } from "vitest";
import {
  aggregateTelemetry,
  hasPendingToolCalls,
  latestReply,
  maxStepIndex,
  mergeFullSteps,
  parseTranscriptLine,
  parseTranscriptText,
  segmentTurns,
  type TranscriptStep,
} from "../../src/domain/transcript-parser";

function step(overrides: Partial<TranscriptStep> & { step_index: number }): TranscriptStep {
  return {
    source: "PLANNER",
    type: "GENERIC",
    status: "DONE",
    created_at: "2026-11-14T02:00:00.000Z",
    content: "",
    thinking: null,
    tool_calls: [],
    input_tokens: 10,
    cache_read_tokens: 20,
    output_tokens: 30,
    truncated_fields: [],
    ...overrides,
  };
}

describe("parseTranscriptLine", () => {
  it("parses a well-formed step line", () => {
    const parsed = parseTranscriptLine(
      JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", content: "hi" }),
    );
    expect(parsed).toMatchObject({
      step_index: 3,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "hi",
    });
  });

  it("returns null for malformed json", () => {
    expect(parseTranscriptLine("{ nope")).toBeNull();
  });

  it("returns null for lines that parse to a non-object", () => {
    expect(parseTranscriptLine("123")).toBeNull();
    expect(parseTranscriptLine('"text"')).toBeNull();
  });

  it("returns null for lines without a step_index", () => {
    expect(parseTranscriptLine(JSON.stringify({ type: "GENERIC" }))).toBeNull();
  });
});

describe("parseTranscriptText", () => {
  it("parses complete lines and skips malformed ones", () => {
    const text = [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE" }),
      "{ broken",
      JSON.stringify({ step_index: 1, type: "GENERIC", status: "DONE" }),
      "",
    ].join("\n");
    const steps = parseTranscriptText(text);
    expect(steps.map((entry) => entry.step_index)).toEqual([0, 1]);
  });

  it("ignores a trailing partial line without a newline", () => {
    const text = `${JSON.stringify({ step_index: 0, type: "USER_INPUT" })}\n{"step_index":1,"type":"GEN`;
    const steps = parseTranscriptText(text);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.step_index).toBe(0);
  });

  it("returns an empty array for empty input", () => {
    expect(parseTranscriptText("")).toEqual([]);
    expect(parseTranscriptText("\n\n")).toEqual([]);
  });
});

describe("segmentTurns", () => {
  it("splits steps into turns at inbound messages", () => {
    const steps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      step({ step_index: 1 }),
      step({ step_index: 2, type: "PLANNER_RESPONSE", content: "first reply" }),
      step({ step_index: 3, type: "SYSTEM_MESSAGE" }),
      step({ step_index: 4 }),
      step({ step_index: 5, type: "PLANNER_RESPONSE", content: "second reply" }),
    ];
    const turns = segmentTurns(steps);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ inboundStepIndex: 0, inboundType: "USER_INPUT" });
    expect(turns[0]?.steps).toHaveLength(3);
    expect(turns[1]).toMatchObject({ inboundStepIndex: 3, inboundType: "SYSTEM_MESSAGE" });
    expect(turns[1]?.steps).toHaveLength(3);
  });

  it("ignores steps before the first inbound message", () => {
    const steps = [
      step({ step_index: 0, type: "PLANNER_RESPONSE" }),
      step({ step_index: 1, type: "USER_INPUT" }),
      step({ step_index: 2, type: "PLANNER_RESPONSE" }),
    ];
    const turns = segmentTurns(steps);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.inboundStepIndex).toBe(1);
  });

  it("treats steps without a type as non-inbound", () => {
    const steps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      { step_index: 1 } as TranscriptStep,
    ];
    const turns = segmentTurns(steps);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.steps).toHaveLength(2);
  });

  it("returns an empty array without inbound messages", () => {
    expect(segmentTurns([step({ step_index: 0 })])).toEqual([]);
  });
});

describe("aggregateTelemetry", () => {
  it("sums token counters and counts steps", () => {
    const steps = [
      step({ step_index: 0, input_tokens: 100, cache_read_tokens: 5, output_tokens: 7 }),
      step({ step_index: 1, input_tokens: 50, cache_read_tokens: 10, output_tokens: 3 }),
    ];
    expect(aggregateTelemetry(steps)).toEqual({
      inputTokens: 150,
      cacheReadTokens: 15,
      outputTokens: 10,
      stepCount: 2,
    });
  });

  it("treats missing token fields as zero", () => {
    const steps = [
      step({
        step_index: 0,
        input_tokens: undefined,
        cache_read_tokens: undefined,
        output_tokens: undefined,
      }),
    ];
    expect(aggregateTelemetry(steps)).toEqual({
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      stepCount: 1,
    });
  });
});

describe("mergeFullSteps", () => {
  it("restores truncated fields from the matching full step", () => {
    const steps = [
      step({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        content: "trunc…",
        truncated_fields: ["content"],
      }),
    ];
    const full = [
      step({ step_index: 2, type: "PLANNER_RESPONSE", content: "the complete reply body" }),
    ];

    const merged = mergeFullSteps(steps, full);
    expect(merged[0]?.content).toBe("the complete reply body");
    expect(merged[0]?.truncated_fields).toEqual(["content"]);
  });

  it("restores only the listed truncated fields", () => {
    const steps = [
      step({
        step_index: 1,
        content: "short",
        thinking: "kept",
        truncated_fields: ["thinking"],
      }),
    ];
    const full = [step({ step_index: 1, content: "longer content", thinking: "full thinking" })];

    const merged = mergeFullSteps(steps, full);
    expect(merged[0]?.content).toBe("short");
    expect(merged[0]?.thinking).toBe("full thinking");
  });

  it("keeps steps untouched when no full counterpart exists", () => {
    const steps = [step({ step_index: 9, content: "solo", truncated_fields: ["content"] })];
    const merged = mergeFullSteps(steps, [step({ step_index: 1 })]);
    expect(merged[0]?.content).toBe("solo");
  });

  it("keeps steps without truncated_fields as-is", () => {
    const steps = [step({ step_index: 0, content: "fine" })];
    const merged = mergeFullSteps(steps, [step({ step_index: 0, content: "different" })]);
    expect(merged[0]?.content).toBe("fine");
  });

  it("treats missing truncated_fields as empty", () => {
    const bare = { step_index: 4, content: "bare" } as TranscriptStep;
    const merged = mergeFullSteps([bare], [step({ step_index: 4, content: "different" })]);
    expect(merged[0]?.content).toBe("bare");
  });

  it("skips truncated fields absent from the full step", () => {
    const steps = [step({ step_index: 2, content: "kept", truncated_fields: ["custom_field"] })];
    const merged = mergeFullSteps(steps, [step({ step_index: 2, content: "changed" })]);
    expect(merged[0]?.content).toBe("kept");
    expect("custom_field" in (merged[0] as object)).toBe(false);
  });
});

describe("maxStepIndex", () => {
  it("returns -1 for empty transcripts", () => {
    expect(maxStepIndex([])).toBe(-1);
  });

  it("returns the highest step index regardless of order", () => {
    const steps = [step({ step_index: 0 }), step({ step_index: 5 }), step({ step_index: 3 })];
    expect(maxStepIndex(steps)).toBe(5);
  });
});

describe("hasPendingToolCalls", () => {
  it("detects tool calls that are not done", () => {
    expect(
      hasPendingToolCalls(
        step({ step_index: 0, tool_calls: [{ name: "run", status: "RUNNING" }] }),
      ),
    ).toBe(true);
    expect(
      hasPendingToolCalls(
        step({ step_index: 0, tool_calls: [{ name: "run", status: "WAITING" }] }),
      ),
    ).toBe(true);
  });

  it("accepts finished tool calls", () => {
    expect(
      hasPendingToolCalls(step({ step_index: 0, tool_calls: [{ name: "run", status: "DONE" }] })),
    ).toBe(false);
    expect(hasPendingToolCalls(step({ step_index: 0, tool_calls: [] }))).toBe(false);
    expect(hasPendingToolCalls({ step_index: 0 } as TranscriptStep)).toBe(false);
    expect(
      hasPendingToolCalls({ step_index: 0, tool_calls: [{ name: "run" }] } as TranscriptStep),
    ).toBe(false);
  });
});

describe("latestReply", () => {
  it("returns the last completed planner response", () => {
    const steps = [
      step({ step_index: 0, type: "USER_INPUT" }),
      step({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "older" }),
      step({ step_index: 2, type: "USER_INPUT" }),
      step({ step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", content: "newest" }),
    ];
    expect(latestReply(steps)?.content).toBe("newest");
  });

  it("skips running planner responses", () => {
    const steps = [step({ step_index: 3, type: "PLANNER_RESPONSE", status: "RUNNING" })];
    expect(latestReply(steps)).toBeUndefined();
  });

  it("returns undefined without any planner response", () => {
    expect(latestReply([step({ step_index: 0 })])).toBeUndefined();
  });
});
