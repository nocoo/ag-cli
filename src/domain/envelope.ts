import { AgCliError } from "../types/protocol";
import { assertTerminalId, isUuid } from "./validation";

export type CallerContext =
  | { kind: "ag-cli"; conversationId: string; shortId?: number; name?: string }
  | { kind: "hc"; terminalId: string };

export function detectCallerContext(env: Record<string, string | undefined>): CallerContext | null {
  const conversationId =
    env.AG_CLI_CALLER_ID?.trim() || env.ANTIGRAVITY_CONVERSATION_ID?.trim() || "";
  if (conversationId.length > 0) {
    if (!isUuid(conversationId)) {
      throw new AgCliError("invalid_usage", `invalid caller conversation id ${conversationId}`, {
        hint: "Caller conversation ids must be 36-character UUIDs.",
      });
    }
    return { kind: "ag-cli", conversationId };
  }
  const terminalId = env.HC_TERMINAL_ID?.trim() || "";
  if (terminalId.length > 0) {
    return { kind: "hc", terminalId: assertTerminalId(terminalId) };
  }
  return null;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function reachTarget(caller: CallerContext): string {
  if (caller.kind === "hc") {
    return caller.terminalId;
  }
  return caller.conversationId;
}

export function buildEnvelope(
  message: string,
  caller: CallerContext,
  options: { cwd: string },
): string {
  const target = reachTarget(caller);
  const from =
    caller.kind === "hc"
      ? `hc:${caller.terminalId}`
      : caller.shortId !== undefined
        ? `c${caller.shortId} ${caller.conversationId.slice(0, 8)}`
        : caller.conversationId;
  const runtime = caller.kind === "hc" ? "hc" : "ag-cli";
  const reach = `${runtime} send ${target} \\"<summary or artifact path>\\" when done or blocked`;
  return (
    `<ag-cli from="${escapeXmlAttribute(from)}" cwd="${escapeXmlAttribute(options.cwd)}" ` +
    `reach="${reach}">\n` +
    `${message}\n` +
    `</ag-cli>`
  );
}

export function buildContextEnvelope(message: string, options: { cwd: string }): string {
  return `<ag-cli cwd="${escapeXmlAttribute(options.cwd)}">\n${message}\n</ag-cli>`;
}

export function wrapOutboundPrompt(
  message: string,
  caller: CallerContext | null,
  options: { cwd: string; noNotify?: boolean; raw?: boolean },
): string {
  if (options.raw === true) {
    return message;
  }
  if (caller === null || options.noNotify === true) {
    return buildContextEnvelope(message, { cwd: options.cwd });
  }
  return buildEnvelope(message, caller, { cwd: options.cwd });
}
