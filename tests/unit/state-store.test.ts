import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../../src/infra/state-store";
import type { NullgError } from "../../src/types/protocol";
import { createSandbox, type Sandbox } from "../helpers/sandbox";

const active: Sandbox[] = [];

function sandbox(): Sandbox {
  const created = createSandbox("nullg-unit-state");
  active.push(created);
  return created;
}

function statePath(instance: Sandbox): string {
  return join(instance.nullgHome, "state.db");
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
    const path = join(instance.nullgHome, "nested", "state.db");
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
          expect((error as NullgError).kind).toBe("invalid_usage");
          expect((error as NullgError).exitCode).toBe(2);
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
        expect((error as NullgError).kind).toBe("name_conflict");
        expect((error as NullgError).exitCode).toBe(1);
      }
    } finally {
      store?.close();
    }
  });

  it("conflicts include conversations holding the name until termination or rm frees it (review F3)", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      store?.registerConversation("11111111-1111-4111-8111-111111111111", { name: "alpha" });
      try {
        store?.registerConversation("22222222-2222-4222-8222-222222222222", { name: "alpha" });
        expect.unreachable("must throw");
      } catch (error) {
        expect((error as NullgError).kind).toBe("name_conflict");
      }
      store?.markTerminated("11111111-1111-4111-8111-111111111111");
      expect(store?.findByConversationId("11111111-1111-4111-8111-111111111111")?.name).toBeNull();
      expect(
        store?.registerConversation("22222222-2222-4222-8222-222222222222", { name: "alpha" })
          .shortId,
      ).toBe(2);
    } finally {
      store?.close();
    }
  });

  it("reports unknown pragmas as null", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      expect(store?.pragma("definitely_not_a_pragma_here")).toBeNull();
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
  it("executes raw sql for maintenance", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      store.rawExec(
        "INSERT INTO conversations (conversation_id, created_at, updated_at) VALUES (?, ?, ?)",
        "21212121-2121-4211-8211-212121212121",
        "2026-11-14T00:00:00Z",
        "2026-11-14T00:00:00Z",
      );
      expect(store?.findByConversationId("21212121-2121-4211-8211-212121212121")).toBeDefined();
    } finally {
      store?.close();
    }
  });

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
        expect((error as NullgError).kind).toBe("invalid_usage");
      }
      try {
        store?.setLabels(id, ["=v"]);
        expect.unreachable("must throw");
      } catch (error) {
        expect((error as NullgError).kind).toBe("invalid_usage");
      }
      try {
        store?.setLabels("99999999-9999-4999-8999-999999999999", ["a=b"]);
        expect.unreachable("must throw");
      } catch (error) {
        expect((error as NullgError).kind).toBe("not_found");
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
      store?.beginDelivery(id, 6);
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

describe("delivery tickets and rollback (review R3 F2)", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";

  it("beginDelivery inserts a missing row and reports createdRow", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      const ticket = store.beginDelivery(first, 4);
      expect(ticket).toEqual({ seq: 1, previousWatermark: -1, createdRow: true });
      expect(store.findByConversationId(first)).toMatchObject({
        watermarkStep: 4,
        deliverySeq: 1,
      });
    } finally {
      store.close();
    }
  });

  it("concurrent double failures restore the original watermark regardless of rollback order", () => {
    for (const order of ["A-first", "B-first"]) {
      const instance = sandbox();
      const store = StateStore.open(statePath(instance), { create: true });
      try {
        store.registerConversation(first, {});
        store.beginDelivery(first, 0);
        const a = store.beginDelivery(first, 2);
        const b = store.beginDelivery(first, 2);
        expect(a.seq).toBeLessThan(b.seq);
        if (order === "A-first") {
          expect(store.rollbackDelivery(first, a)).toBe(false);
          expect(store.rollbackDelivery(first, b)).toBe(true);
        } else {
          expect(store.rollbackDelivery(first, b)).toBe(true);
          expect(store.rollbackDelivery(first, a)).toBe(true);
        }
        const row = store.findByConversationId(first);
        expect(row).toMatchObject({ watermarkStep: 0, terminated: 0 });
      } finally {
        store.close();
      }
    }
  });

  it("a failed delivery never clobbers a concurrent committed delivery", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      store.registerConversation(first, {});
      const a = store.beginDelivery(first, 2);
      const b = store.beginDelivery(first, 5);
      store.commitDelivery(first, b);
      expect(store.rollbackDelivery(first, a)).toBe(false);
      expect(store.findByConversationId(first)?.watermarkStep).toBe(5);
    } finally {
      store.close();
    }
  });

  it("rollback of a ticket that created the row deletes the row when nothing else landed", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      const a = store.beginDelivery(first, 4);
      expect(store.rollbackDelivery(first, a)).toBe(true);
      expect(store.findByConversationId(first)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("labels keep the row alive for a failed creating delivery and restore the watermark", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      const a = store.beginDelivery(first, 4);
      store.setLabels(first, ["keep=value"]);
      expect(store.rollbackDelivery(first, a)).toBe(true);
      expect(store.findByConversationId(first)).toBeDefined();
      expect(store.findByConversationId(first)?.watermarkStep).toBe(-1);
      expect(store.listLabels(first)).toEqual([{ key: "keep", value: "value" }]);
    } finally {
      store.close();
    }
  });

  it("delete and recreate never lets an old ticket roll back the new row (review R3 ABA)", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      const old = store.beginDelivery(first, 2);
      store.commitDelivery(first, old);
      store.removeConversation(first);
      const fresh = store.beginDelivery(first, 3);
      expect(fresh.seq).toBeGreaterThan(old.seq);
      expect(store.rollbackDelivery(first, old)).toBe(false);
      expect(store.findByConversationId(first)).toBeDefined();
      expect(store.findByConversationId(first)?.watermarkStep).toBe(3);
    } finally {
      store.close();
    }
  });

  it("removeConversation clears pending tickets for the conversation", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      const a = store.beginDelivery(first, 2);
      store.removeConversation(first);
      expect(store.rollbackDelivery(first, a)).toBe(false);
      expect(store.beginDelivery(second, 1).seq).toBe(2);
    } finally {
      store.close();
    }
  });

  it("migrates an existing state.db without the delivery tables (review F2)", () => {
    const instance = sandbox();
    const path = statePath(instance);
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE conversations (
        short_id        INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL UNIQUE,
        name            TEXT UNIQUE,
        parent_id       TEXT,
        cwd             TEXT,
        project_id      TEXT,
        model           TEXT,
        watermark_step  INTEGER NOT NULL DEFAULT -1,
        last_turn       INTEGER NOT NULL DEFAULT 0,
        terminated      INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE TABLE labels (
        conversation_id TEXT NOT NULL,
        key             TEXT NOT NULL,
        value           TEXT NOT NULL,
        PRIMARY KEY (conversation_id, key)
      );
    `);
    legacy
      .prepare(
        "INSERT INTO conversations (conversation_id, name, watermark_step, created_at, updated_at) VALUES (?, ?, 7, ?, ?)",
      )
      .run(first, "legacy", "2026-11-14T00:00:00Z", "2026-11-14T00:00:00Z");
    legacy.close();

    const store = StateStore.open(path, { create: true });
    try {
      expect(store.findByConversationId(first)).toMatchObject({
        name: "legacy",
        watermarkStep: 7,
        deliverySeq: 0,
      });
      const ticket = store.beginDelivery(first, 9);
      expect(ticket).toEqual({ seq: 1, previousWatermark: 7, createdRow: false });
    } finally {
      store.close();
    }
  });
});

describe("name reservations (review F3)", () => {
  it("acquireNameReservation is exclusive per name and token-scoped on release", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      expect(store.acquireNameReservation("worker", "token-a")).toBe(true);
      expect(store.acquireNameReservation("worker", "token-b")).toBe(false);
      expect(store.acquireNameReservation("other", "token-b")).toBe(true);
      // releasing with a foreign token must not free the reservation
      store.releaseNameReservation("worker", "token-b");
      expect(store.acquireNameReservation("worker", "token-c")).toBe(false);
      store.releaseNameReservation("worker", "token-a");
      expect(store.acquireNameReservation("worker", "token-c")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("reservations are independent of conversation names", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      store.registerConversation("11111111-1111-4111-8111-111111111111", { name: "worker" });
      expect(store.acquireNameReservation("worker", "token-a")).toBe(true);
      store.releaseNameReservation("worker", "token-a");
      expect(store.findByConversationId("11111111-1111-4111-8111-111111111111")?.name).toBe(
        "worker",
      );
    } finally {
      store.close();
    }
  });

  it("purges stale reservations past the ttl and keeps fresh ones exclusive (review R3 F3)", () => {
    const instance = sandbox();
    const store = StateStore.open(statePath(instance), { create: true });
    try {
      expect(store.acquireNameReservation("orphan", "dead-token")).toBe(true);
      store.rawExec(
        "UPDATE name_reservations SET created_at = '2000-01-01T00:00:00Z' WHERE name = 'orphan'",
      );
      expect(store.acquireNameReservation("orphan", "new-token")).toBe(true);
      store.releaseNameReservation("orphan", "new-token");

      expect(store.acquireNameReservation("fresh", "token-a")).toBe(true);
      expect(store.acquireNameReservation("fresh", "token-b")).toBe(false);
      store.rawExec("UPDATE name_reservations SET created_at = 'not-a-date' WHERE name = 'fresh'");
      expect(store.acquireNameReservation("fresh", "token-c")).toBe(true);

      store.releaseNameReservation("fresh", "token-c");
      expect(store.acquireNameReservation("edge", "token-a", 60_000)).toBe(true);
      expect(store.acquireNameReservation("edge", "token-b", 60_000)).toBe(false);
    } finally {
      store.close();
    }
  });
});
