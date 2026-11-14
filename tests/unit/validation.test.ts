import { describe, expect, it } from "vitest";
import {
  ALIAS_RE,
  assertAlias,
  assertTerminalId,
  assertUuid,
  isUuid,
  RESERVED_ALIAS_RE,
  TERMINAL_ID_RE,
} from "../../src/domain/validation";
import type { AgCliError } from "../../src/types/protocol";

describe("uuid validation", () => {
  it("accepts canonical uuids in any case", () => {
    expect(isUuid("990014f6-f6d1-4567-adcf-6182cead394c")).toBe(true);
    expect(isUuid("990014F6-F6D1-4567-ADCF-6182CEAD394C")).toBe(true);
  });

  it("rejects path traversal and truncated ids", () => {
    for (const bad of [
      "../../victim",
      "not-a-uuid",
      "990014f6-f6d1-4567-adcf",
      "990014f6f6d14567adcf6182cead394c",
    ]) {
      expect(isUuid(bad)).toBe(false);
    }
  });

  it("returns valid uuids unchanged", () => {
    expect(assertUuid("990014f6-f6d1-4567-adcf-6182cead394c")).toBe(
      "990014f6-f6d1-4567-adcf-6182cead394c",
    );
  });

  it("throws invalid_usage for user supplied ids and runtime_error for upstream ids", () => {
    try {
      assertUuid("../../victim");
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("invalid_usage");
      expect((error as AgCliError).exitCode).toBe(2);
    }

    try {
      assertUuid("nope", "upstream");
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("runtime_error");
      expect((error as AgCliError).exitCode).toBe(1);
    }
  });
});

describe("alias validation", () => {
  it("keeps short-id style names reserved", () => {
    expect(RESERVED_ALIAS_RE.test("c1")).toBe(true);
    expect(RESERVED_ALIAS_RE.test("C12")).toBe(true);
    expect(RESERVED_ALIAS_RE.test("clip")).toBe(false);
    expect(ALIAS_RE.test("clip-worker")).toBe(true);
    expect(ALIAS_RE.test("Bad")).toBe(false);
  });

  it("rejects reserved and malformed aliases with invalid_usage", () => {
    for (const bad of ["c1", "C7", "Bad", "-lead", "with space"]) {
      try {
        assertAlias(bad);
        expect.unreachable(`must throw for ${bad}`);
      } catch (error) {
        expect((error as AgCliError).kind).toBe("invalid_usage");
      }
    }
    expect(assertAlias("deps-clip")).toBe("deps-clip");
  });
});

describe("path safety", () => {
  it("accepts paths inside the root and rejects escapes", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { assertInside } = await import("../../src/infra/path-safety");
    const root = mkdtempSync(join(tmpdir(), "safety-"));
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "file.txt"), "x");

    expect(assertInside(root, root)).toBeTruthy();
    expect(assertInside(root, join(root, "nested", "file.txt"))).toBeTruthy();
    expect(() => assertInside(root, join(root, "nested", "missing.txt"))).not.toThrow();
    expect(() => assertInside(root, join(root, "..", "escape.txt"))).toThrow();
  });
});

describe("terminal id validation", () => {
  it("accepts simple terminal ids and rejects unsafe ones", () => {
    expect(TERMINAL_ID_RE.test("t7")).toBe(true);
    expect(TERMINAL_ID_RE.test("hc.team-1")).toBe(true);
    try {
      assertTerminalId("t7; rm -rf /");
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as AgCliError).kind).toBe("invalid_usage");
    }
  });
});
