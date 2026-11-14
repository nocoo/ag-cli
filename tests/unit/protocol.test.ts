import { describe, expect, it } from "vitest";
import { AgCliError, ERROR_KIND_EXIT_CODES, EXIT_CODES } from "../../src/types/protocol";

describe("EXIT_CODES", () => {
  it("matches the exit code contract from docs/02 §5", () => {
    expect(EXIT_CODES).toEqual({
      ok: 0,
      failure: 1,
      invalidUsage: 2,
      preconditionFailed: 3,
      daemonUnavailable: 4,
      timeout: 124,
    });
  });
});

describe("ERROR_KIND_EXIT_CODES", () => {
  it("maps every error kind to its contract exit code", () => {
    expect(ERROR_KIND_EXIT_CODES).toEqual({
      runtime_error: 1,
      not_found: 1,
      ambiguous_target: 1,
      name_conflict: 1,
      blocked_conversation: 1,
      invalid_usage: 2,
      precondition_failed: 3,
      daemon_unavailable: 4,
      timeout: 124,
    });
  });
});

describe("AgCliError", () => {
  it("carries kind, message and derived exit code", () => {
    const error = new AgCliError("not_found", "conversation c99 not found");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AgCliError");
    expect(error.kind).toBe("not_found");
    expect(error.message).toBe("conversation c99 not found");
    expect(error.exitCode).toBe(1);
    expect(error.hint).toBeUndefined();
  });

  it("keeps an optional hint and cause", () => {
    const cause = new Error("boom");
    const error = new AgCliError("precondition_failed", "expected idle", {
      hint: "Run `ag-cli wait c12` first.",
      cause,
    });

    expect(error.hint).toBe("Run `ag-cli wait c12` first.");
    expect(error.cause).toBe(cause);
    expect(error.exitCode).toBe(3);
  });

  it("derives exit codes for the remaining contract kinds", () => {
    expect(new AgCliError("invalid_usage", "bad flag").exitCode).toBe(2);
    expect(new AgCliError("daemon_unavailable", "no hub").exitCode).toBe(4);
    expect(new AgCliError("timeout", "timed out").exitCode).toBe(124);
  });
});
