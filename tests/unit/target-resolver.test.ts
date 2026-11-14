import { describe, expect, it } from "vitest";
import {
  type ManagedConversation,
  resolveTarget,
  type TargetRegistry,
} from "../../src/domain/target-resolver";
import { AgCliError } from "../../src/types/protocol";

const UUID_A = "990014f6-f6d1-4567-adcf-6182cead394c";
const UUID_B = "a464a19f-0e6a-4c5f-9d5c-1b2c3d4e5f60";
const UUID_C = "a464b7c2-1122-4333-8444-5060708090a1";

function registry(partial: Partial<TargetRegistry> = {}): TargetRegistry {
  return {
    managed: [],
    summaryIds: [],
    brainIds: [],
    ...partial,
  };
}

function managed(
  entry: Partial<ManagedConversation> & { shortId: number; conversationId: string },
): ManagedConversation {
  return { name: null, terminated: 0, ...entry };
}

describe("resolveTarget priority (docs/02 §2)", () => {
  it("resolves an exact active alias name first", () => {
    const state = registry({
      managed: [
        managed({ shortId: 7, conversationId: UUID_A, name: "clip-worker" }),
        managed({ shortId: 8, conversationId: UUID_B, name: "c7" }),
      ],
      summaryIds: [UUID_A, UUID_B],
      brainIds: [UUID_A, UUID_B],
    });

    expect(resolveTarget("clip-worker", state)).toEqual({
      conversationId: UUID_A,
      via: "name",
      shortId: 7,
      name: "clip-worker",
    });
  });

  it("prefers an alias literally named c7 over short id 7", () => {
    const state = registry({
      managed: [
        managed({ shortId: 7, conversationId: UUID_A }),
        managed({ shortId: 8, conversationId: UUID_B, name: "c7" }),
      ],
    });

    expect(resolveTarget("c7", state)).toEqual({
      conversationId: UUID_B,
      via: "name",
      shortId: 8,
      name: "c7",
    });
  });

  it("falls back to short id resolution when no alias matches", () => {
    const state = registry({
      managed: [managed({ shortId: 7, conversationId: UUID_A, name: "deps-clip" })],
    });

    expect(resolveTarget("c7", state)).toEqual({
      conversationId: UUID_A,
      via: "shortId",
      shortId: 7,
      name: "deps-clip",
    });
  });

  it("resolves a full 36-char uuid even when unmanaged", () => {
    const state = registry({ summaryIds: [UUID_A] });
    expect(resolveTarget(UUID_A.toUpperCase(), state)).toEqual({
      conversationId: UUID_A,
      via: "uuid",
    });
  });

  it("attaches no alias when managed rows lack names", () => {
    const state = registry({
      managed: [managed({ shortId: 4, conversationId: UUID_A })],
      summaryIds: [UUID_A],
    });
    expect(resolveTarget("c4", state)).toEqual({
      conversationId: UUID_A,
      via: "shortId",
      shortId: 4,
    });
    expect(resolveTarget(UUID_A, state)).toEqual({
      conversationId: UUID_A,
      via: "uuid",
      shortId: 4,
    });
  });

  it("resolves a unique uuid hex prefix across summaries and brain", () => {
    const state = registry({ summaryIds: [UUID_A], brainIds: [UUID_B] });
    expect(resolveTarget("990014f6", state)).toEqual({
      conversationId: UUID_A,
      via: "uuidPrefix",
    });
    expect(resolveTarget("a464a19f", state)).toEqual({
      conversationId: UUID_B,
      via: "uuidPrefix",
    });
  });

  it("resolves a uuid prefix owned by a managed conversation with its alias metadata", () => {
    const state = registry({
      managed: [managed({ shortId: 3, conversationId: UUID_A, name: "deps-clip" })],
    });
    expect(resolveTarget("990014f6", state)).toEqual({
      conversationId: UUID_A,
      via: "uuidPrefix",
      shortId: 3,
      name: "deps-clip",
    });
  });

  it("rejects a prefix that matches nothing with not_found", () => {
    const state = registry({ summaryIds: [UUID_A] });
    try {
      resolveTarget("abcdef01", state);
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("not_found");
    }
  });

  it("throws ambiguous_target when a prefix matches several conversations", () => {
    const state = registry({ summaryIds: [UUID_B, UUID_C] });
    try {
      resolveTarget("a464", state);
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgCliError);
      const agError = error as AgCliError;
      expect(agError.kind).toBe("ambiguous_target");
      expect(agError.exitCode).toBe(1);
      expect(agError.message).toContain(UUID_B);
      expect(agError.message).toContain(UUID_C);
    }
  });

  it("rejects a name-shaped target that exists nowhere with not_found", () => {
    const state = registry();
    try {
      resolveTarget("ghost-worker", state);
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("not_found");
    }
  });

  it("rejects an unknown short id with not_found", () => {
    const state = registry();
    try {
      resolveTarget("c99", state);
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("not_found");
    }
  });

  it("rejects an unknown full uuid with not_found", () => {
    const state = registry({ summaryIds: [UUID_A] });
    try {
      resolveTarget("11111111-2222-4333-8444-555566667777", state);
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("not_found");
    }
  });

  it("rejects malformed targets with invalid_usage", () => {
    const state = registry();
    for (const bad of ["Bad Name", "with.dot", "-leading", "a b", "UPPER"]) {
      try {
        resolveTarget(bad, state);
        expect.unreachable(`must throw for ${bad}`);
      } catch (error) {
        expect((error as AgCliError).kind).toBe("invalid_usage");
        expect((error as AgCliError).exitCode).toBe(2);
      }
    }
  });

  it("does not resolve terminated conversations by alias", () => {
    const state = registry({
      managed: [
        managed({ shortId: 7, conversationId: UUID_A, name: "dead-worker", terminated: 1 }),
      ],
    });
    try {
      resolveTarget("dead-worker", state);
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("not_found");
    }
  });

  it("still resolves terminated conversations by short id and uuid", () => {
    const state = registry({
      managed: [
        managed({ shortId: 7, conversationId: UUID_A, name: "dead-worker", terminated: 1 }),
      ],
    });
    expect(resolveTarget("c7", state).conversationId).toBe(UUID_A);
    expect(resolveTarget(UUID_A, state).conversationId).toBe(UUID_A);
  });
});

describe("resolveTarget caller default (docs/02 §2)", () => {
  it("defaults to the caller conversation when target is omitted", () => {
    const state = registry({ summaryIds: [UUID_A] });
    expect(resolveTarget(undefined, state, { callerId: UUID_A })).toEqual({
      conversationId: UUID_A,
      via: "caller",
    });
  });

  it("attaches managed alias metadata to the caller default", () => {
    const state = registry({
      managed: [managed({ shortId: 5, conversationId: UUID_A, name: "orch" })],
    });
    expect(resolveTarget(undefined, state, { callerId: UUID_A })).toEqual({
      conversationId: UUID_A,
      via: "caller",
      shortId: 5,
      name: "orch",
    });
  });

  it("fails with not_found when the caller conversation is unknown", () => {
    const state = registry();
    try {
      resolveTarget(undefined, state, { callerId: UUID_A });
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("not_found");
    }
  });

  it("fails with invalid_usage (exit 2) without target or caller", () => {
    const state = registry();
    try {
      resolveTarget(undefined, state);
      expect.unreachable("must throw");
    } catch (error) {
      const agError = error as AgCliError;
      expect(agError.kind).toBe("invalid_usage");
      expect(agError.exitCode).toBe(2);
      expect(agError.message).toContain("missing_target");
    }
  });

  it("ignores an empty caller id", () => {
    const state = registry();
    try {
      resolveTarget(undefined, state, { callerId: "" });
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("invalid_usage");
    }
  });
});
