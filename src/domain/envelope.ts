export type CallerContext =
  | { kind: "ag-cli"; conversationId: string; shortId?: number; name?: string }
  | { kind: "hc"; terminalId: string };

export function detectCallerContext(env: Record<string, string | undefined>): CallerContext | null {
  const conversationId =
    env.AG_CLI_CALLER_ID?.trim() || env.ANTIGRAVITY_CONVERSATION_ID?.trim() || "";
  if (conversationId.length > 0) {
    return { kind: "ag-cli", conversationId };
  }
  const terminalId = env.HC_TERMINAL_ID?.trim() || "";
  if (terminalId.length > 0) {
    return { kind: "hc", terminalId };
  }
  return null;
}

function reachTarget(caller: CallerContext): string {
  if (caller.kind === "hc") {
    return caller.terminalId;
  }
  return caller.shortId !== undefined ? `c${caller.shortId}` : caller.conversationId.slice(0, 8);
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
        : caller.conversationId.slice(0, 8);
  const runtime = caller.kind === "hc" ? "hc" : "ag-cli";
  return (
    `<ag-cli from="${from}" cwd="${options.cwd}" ` +
    `reach="${runtime} send ${target} \\"<summary or artifact path>\\" when done or blocked">\n` +
    `${message}\n` +
    `</ag-cli>`
  );
}

export function wrapOutboundPrompt(
  message: string,
  caller: CallerContext | null,
  options: { cwd: string; noNotify?: boolean; raw?: boolean },
): string {
  if (caller === null || options.noNotify === true || options.raw === true) {
    return message;
  }
  return buildEnvelope(message, caller, { cwd: options.cwd });
}
