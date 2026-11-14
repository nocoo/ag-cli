import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../../src/infra/state-store";
import type { AgCliError } from "../../src/types/protocol";
import { createSandbox, type Sandbox } from "../helpers/sandbox";

const active: Sandbox[] = [];

function sandbox(): Sandbox {
  const created = createSandbox("ag-cli-unit-state");
  active.push(created);
  return created;
}

function statePath(instance: Sandbox): string {
  return join(instance.agCliHome, "state.db");
}

afterEach(() => {
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

describe("StateStore.open", () => {
  it("returns null when the database is missing and create is not requested", () => {
    const instance = sandbox();
    expect(StateStore.open(statePath(instance))).toBeNull();
  });

  it("creates the parent directory and schema with create: true", () => {
    const instance = sandbox();
    const path = join(instance.agCliHome, "nested", "state.db");
    const store = StateStore.open(path, { create: true });
    expect(store).not.toBeNull();
    try {
      expect(existsSync(path)).toBe(true);
      const journal = store?.pragma("journal_mode") as string;
      expect(journal.toLowerCase()).toContain("wal");
      expect(store?.pragma("foreign_keys")).toBe(1);
      expect(store?.pragma("busy_timeout")).toBe(3000);
    } finally {
      store?.close();
    }
  });

  it("reopens an existing database without create", () => {
    const instance = sandbox();
    const first = StateStore.open(statePath(instance), { create: true });
    first?.registerConversation("11111111-1111-4111-8111-111111111111", { name: "first" });
    first?.close();

    const second = StateStore.open(statePath(instance));
    expect(second?.findByConversationId("11111111-1111-4111-8111-111111111111")?.name).toBe(
      "first",
    );
    second?.close();
  });
});

describe("registerConversation", () => {
  it("assigns incrementing short ids c1..cN and timestamps", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      const first = store?.registerConversation("11111111-1111-4111-8111-111111111111", {
        name: "alpha",
        parentId: "p",
        cwd: "/tmp/repo",
        projectId: "proj-1",
        model: "flash",
      });
      const second = store?.registerConversation("22222222-2222-4222-8222-222222222222", {});
      expect(first).toMatchObject({
        shortId: 1,
        conversationId: "11111111-1111-4111-8111-111111111111",
        name: "alpha",
        parentId: "p",
        cwd: "/tmp/repo",
        projectId: "proj-1",
        model: "flash",
        watermarkStep: -1,
        lastTurn: 0,
        terminated: 0,
      });
      expect(typeof first?.createdAt).toBe("string");
      expect(second?.shortId).toBe(2);
      expect(second?.name).toBeNull();
    } finally {
      store?.close();
    }
  });

  it("rejects invalid names with invalid_usage", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      for (const bad of ["Bad", "-lead", "with space", "x".repeat(33), "a.b"]) {
        try {
          store?.registerConversation("11111111-1111-4111-8111-111111111111", { name: bad });
          expect.unreachable(`must throw for ${bad}`);
        } catch (error) {
          expect((error as AgCliError).kind).toBe("invalid_usage");
          expect((error as AgCliError).exitCode).toBe(2);
        }
      }
    } finally {
      store?.close();
    }
  });

  it("rejects duplicate names with name_conflict", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      store?.registerConversation("11111111-1111-4111-8111-111111111111", { name: "alpha" });
      try {
        store?.registerConversation("22222222-2222-4222-8222-222222222222", { name: "alpha" });
        expect.unreachable("must throw");
      } catch (error) {
        expect((error as AgCliError).kind).toBe("name_conflict");
        expect((error as AgCliError).exitCode).toBe(1);
      }
    } finally {
      store?.close();
    }
  });

  it("conflicts include terminated conversations until rm frees the name", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      store?.registerConversation("11111111-1111-4111-8111-111111111111", { name: "alpha" });
      store?.markTerminated("11111111-1111-4111-8111-111111111111");
      try {
        store?.registerConversation("22222222-2222-4222-8222-222222222222", { name: "alpha" });
        expect.unreachable("must throw");
      } catch (error) {
        expect((error as AgCliError).kind).toBe("name_conflict");
      }
      store?.removeConversation("11111111-1111-4111-8111-111111111111");
      expect(
        store?.registerConversation("22222222-2222-4222-8222-222222222222", { name: "alpha" })
          .shortId,
      ).toBe(2);
    } finally {
      store?.close();
    }
  });

  it("re-registering the same conversation id is idempotent via ensureConversation", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      const first = store?.ensureConversation("11111111-1111-4111-8111-111111111111", {
        name: "alpha",
      });
      const again = store?.ensureConversation("11111111-1111-4111-8111-111111111111", {});
      expect(again?.shortId).toBe(first?.shortId);
      expect(again?.name).toBe("alpha");
    } finally {
      store?.close();
    }
  });
});

describe("queries and mutations", () => {
  it("findActiveByName ignores terminated conversations", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      store?.registerConversation("11111111-1111-4111-8111-111111111111", { name: "alpha" });
      store?.registerConversation("22222222-2222-4222-8222-222222222222", { name: "beta" });
      store?.markTerminated("22222222-2222-4222-8222-222222222222");
      expect(store?.findActiveByName("alpha")?.conversationId).toBe(
        "11111111-1111-4111-8111-111111111111",
      );
      expect(store?.findActiveByName("beta")).toBeUndefined();
      expect(store?.listManaged()).toHaveLength(2);
      expect(store?.listManaged({ activeOnly: true })).toHaveLength(1);
    } finally {
      store?.close();
    }
  });

  it("upserts and removes labels and rejects malformed pairs", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    const id = "11111111-1111-4111-8111-111111111111";
    try {
      store?.registerConversation(id, {});
      store?.setLabels(id, ["task=deps-fix", "repo=clip"]);
      store?.setLabels(id, ["repo=media"]);
      store?.setLabels(id, ["task="]);
      expect(store?.listLabels(id)).toEqual([{ key: "repo", value: "media" }]);
      try {
        store?.setLabels(id, ["no-separator"]);
        expect.unreachable("must throw");
      } catch (error) {
        expect((error as AgCliError).kind).toBe("invalid_usage");
      }
      try {
        store?.setLabels(id, ["=v"]);
        expect.unreachable("must throw");
      } catch (error) {
        expect((error as AgCliError).kind).toBe("invalid_usage");
      }
      try {
        store?.setLabels("99999999-9999-4999-8999-999999999999", ["a=b"]);
        expect.unreachable("must throw");
      } catch (error) {
        expect((error as AgCliError).kind).toBe("not_found");
      }
    } finally {
      store?.close();
    }
  });

  it("updates watermark, advances turns and terminates", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    const id = "11111111-1111-4111-8111-111111111111";
    try {
      store?.registerConversation(id, {});
      store?.updateWatermark(id, 6);
      store?.advanceTurn(id);
      store?.advanceTurn(id);
      store?.markTerminated(id);
      const row = store?.findByConversationId(id);
      expect(row).toMatchObject({ watermarkStep: 6, lastTurn: 2, terminated: 1 });
    } finally {
      store?.close();
    }
  });

  it("removes conversations and cascades labels", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    const id = "11111111-1111-4111-8111-111111111111";
    try {
      store?.registerConversation(id, { name: "alpha" });
      store?.setLabels(id, ["k=v"]);
      store?.removeConversation(id);
      expect(store?.findByConversationId(id)).toBeUndefined();
      expect(store?.listLabels(id)).toEqual([]);
      expect(
        store?.registerConversation("22222222-2222-4222-8222-222222222222", { name: "alpha" }),
      ).toBeDefined();
    } finally {
      store?.close();
    }
  });
});
