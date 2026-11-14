import { AgCliError } from "../types/protocol";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const RESERVED_ALIAS_RE = /^c\d+$/i;
export const TERMINAL_ID_RE = /^[A-Za-z0-9._-]+$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function assertUuid(value: string, source: "input" | "upstream" = "input"): string {
  if (isUuid(value)) {
    return value;
  }
  throw new AgCliError(
    source === "upstream" ? "runtime_error" : "invalid_usage",
    `invalid conversation id ${JSON.stringify(value)}`,
    { hint: "Conversation ids must be 36-character UUIDs." },
  );
}

export function assertAlias(name: string): string {
  if (!ALIAS_RE.test(name)) {
    throw new AgCliError("invalid_usage", `invalid name ${name}`, {
      hint: "Names match ^[a-z0-9][a-z0-9_-]{0,31}$.",
    });
  }
  if (RESERVED_ALIAS_RE.test(name)) {
    throw new AgCliError("invalid_usage", `name ${name} is reserved for short ids`, {
      hint: "Names like c1 are resolved as short ids; pick another name.",
    });
  }
  return name;
}

export function assertTerminalId(value: string): string {
  if (!TERMINAL_ID_RE.test(value)) {
    throw new AgCliError("invalid_usage", `invalid terminal id ${JSON.stringify(value)}`, {
      hint: "Terminal ids match ^[A-Za-z0-9._-]+$.",
    });
  }
  return value;
}
