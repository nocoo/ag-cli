export type ErrorKind =
  | "runtime_error"
  | "not_found"
  | "ambiguous_target"
  | "name_conflict"
  | "blocked_conversation"
  | "invalid_usage"
  | "precondition_failed"
  | "daemon_unavailable"
  | "timeout";

export type ConversationStatus = "idle" | "working" | "done" | "blocked" | "error";

export type WaitReason = "done" | "blocked" | "error" | "message" | "timeout";

export const EXIT_CODES = {
  ok: 0,
  failure: 1,
  invalidUsage: 2,
  preconditionFailed: 3,
  daemonUnavailable: 4,
  timeout: 124,
} as const;

export const ERROR_KIND_EXIT_CODES: Record<ErrorKind, number> = {
  runtime_error: EXIT_CODES.failure,
  not_found: EXIT_CODES.failure,
  ambiguous_target: EXIT_CODES.failure,
  name_conflict: EXIT_CODES.failure,
  blocked_conversation: EXIT_CODES.failure,
  invalid_usage: EXIT_CODES.invalidUsage,
  precondition_failed: EXIT_CODES.preconditionFailed,
  daemon_unavailable: EXIT_CODES.daemonUnavailable,
  timeout: EXIT_CODES.timeout,
};

export class NullgError extends Error {
  readonly kind: ErrorKind;
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(kind: ErrorKind, message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "NullgError";
    this.kind = kind;
    this.hint = options.hint;
    this.exitCode = ERROR_KIND_EXIT_CODES[kind];
  }
}
