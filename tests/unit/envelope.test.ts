import { describe, expect, it } from "vitest";
import { buildEnvelope, detectCallerContext, wrapOutboundPrompt } from "../../src/domain/envelope";

const AG_UUID = "a464a19f-0e6a-4c5f-9d5c-1b2c3d4e5f60";

describe("detectCallerContext", () => {
  it("rejects invalid caller and terminal ids", () => {
    expect(() => detectCallerContext({ ANTIGRAVITY_CONVERSATION_ID: "not-a-uuid" })).toThrow();
    expect(() => detectCallerContext({ HC_TERMINAL_ID: "t7; rm -rf /" })).toThrow();
  });

  it("detects an Antigravity caller via ANTIGRAVITY_CONVERSATION_ID", () => {
    expect(detectCallerContext({ ANTIGRAVITY_CONVERSATION_ID: AG_UUID })).toEqual({
      kind: "ag-cli",
      conversationId: AG_UUID,
    });
  });

  it("prefers AG_CLI_CALLER_ID and reads metadata through overrides", () => {
    expect(
      detectCallerContext({
        AG_CLI_CALLER_ID: AG_UUID,
        ANTIGRAVITY_CONVERSATION_ID: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({ kind: "ag-cli", conversationId: AG_UUID });
  });

  it("detects an hc terminal caller via HC_TERMINAL_ID", () => {
    expect(detectCallerContext({ HC_TERMINAL_ID: "t7" })).toEqual({ kind: "hc", terminalId: "t7" });
  });

  it("returns null for external callers", () => {
    expect(detectCallerContext({})).toBeNull();
  });

  it("ignores empty values", () => {
    expect(detectCallerContext({ ANTIGRAVITY_CONVERSATION_ID: "", HC_TERMINAL_ID: "" })).toBeNull();
  });
});

describe("buildEnvelope (docs/02 §4)", () => {
  it("wraps prompts from a managed Antigravity caller", () => {
    const envelope = buildEnvelope(
      "请升级依赖并创建 PR。",
      { kind: "ag-cli", conversationId: AG_UUID, shortId: 3 },
      { cwd: "/Users/nocoo/workspace/personal/clip" },
    );
    expect(envelope).toBe(
      '<ag-cli from="c3 a464a19f" cwd="/Users/nocoo/workspace/personal/clip" ' +
        `reach="ag-cli send ${AG_UUID} \\"<summary or artifact path>\\" when done or blocked">\n` +
        "请升级依赖并创建 PR。\n" +
        "</ag-cli>",
    );
  });

  it("uses the raw uuid when the caller has no short id", () => {
    const envelope = buildEnvelope(
      "task",
      { kind: "ag-cli", conversationId: AG_UUID },
      { cwd: "/w" },
    );
    expect(envelope).toContain(`from="${AG_UUID}"`);
    expect(envelope).toContain(
      `reach="ag-cli send ${AG_UUID} \\"<summary or artifact path>\\" when done or blocked"`,
    );
  });

  it("wraps prompts from an hc terminal bot with a cross-runtime reach", () => {
    const envelope = buildEnvelope(
      "verify login",
      { kind: "hc", terminalId: "t7" },
      { cwd: "/app" },
    );
    expect(envelope).toBe(
      '<ag-cli from="hc:t7" cwd="/app" ' +
        'reach="hc send t7 \\"<summary or artifact path>\\" when done or blocked">\n' +
        "verify login\n" +
        "</ag-cli>",
    );
  });
});

describe("wrapOutboundPrompt", () => {
  it("injects a cwd-only envelope without a caller", () => {
    expect(wrapOutboundPrompt("plain", null, { cwd: "/w" })).toBe(
      '<ag-cli cwd="/w">\nplain\n</ag-cli>',
    );
  });

  it("drops from and reach with --no-notify but keeps the cwd context", () => {
    const caller = { kind: "hc" as const, terminalId: "t7" };
    const wrapped = wrapOutboundPrompt("plain", caller, { cwd: "/w", noNotify: true });
    expect(wrapped).toBe('<ag-cli cwd="/w">\nplain\n</ag-cli>');
    expect(wrapped).not.toContain("reach=");
  });

  it("keeps the message raw with --raw", () => {
    const caller = { kind: "hc" as const, terminalId: "t7" };
    expect(wrapOutboundPrompt("plain", caller, { cwd: "/w", raw: true })).toBe("plain");
  });

  it("escapes xml attributes", () => {
    const envelope = buildEnvelope("task", { kind: "hc", terminalId: "t7" }, { cwd: '/tmp/"<&>' });
    expect(envelope).toContain('cwd="/tmp/&quot;&lt;&amp;&gt;"');
  });

  it("wraps by default", () => {
    const caller = { kind: "hc" as const, terminalId: "t7" };
    expect(wrapOutboundPrompt("plain", caller, { cwd: "/w" })).toContain('<ag-cli from="hc:t7"');
  });
});
