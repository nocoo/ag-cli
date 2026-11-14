import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../../src/infra/state-store";
import { createSandbox, initSummariesDb, type Sandbox } from "../helpers/sandbox";

const active: Sandbox[] = [];

function sandbox(): Sandbox {
  const created = createSandbox("nullg-int-state");
  active.push(created);
  return created;
}

afterEach(() => {
  for (const instance of active.splice(0)) {
    instance.cleanup();
  }
});

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("StateStore under real sqlite", () => {
  it("supports concurrent reader connections in WAL mode while a writer holds data", () => {
    const instance = sandbox();
    const path = join(instance.nullgHome, "state.db");
    const writer = StateStore.open(path, { create: true });
    writer?.registerConversation(UUID_A, { name: "alpha" });
    writer?.setLabels(UUID_A, ["task=deps"]);

    const reader = StateStore.open(path);
    expect(reader).not.toBeNull();
    try {
      expect(reader?.findByConversationId(UUID_A)).toMatchObject({ name: "alpha" });
      expect(reader?.listLabels(UUID_A)).toEqual([{ key: "task", value: "deps" }]);
    } finally {
      reader?.close();
      writer?.close();
    }
  });

  it("enforces the labels foreign key with deletes rejected for unknown conversations", () => {
    const instance = sandbox();
    const store = StateStore.open(join(instance.nullgHome, "state.db"), { create: true });
    try {
      expect(() =>
        store?.rawExec(
          "INSERT INTO labels (conversation_id, key, value) VALUES (?, 'k', 'v')",
          UUID_B,
        ),
      ).toThrow();
    } finally {
      store?.close();
    }
  });

  it("rolls back deliveries only when the ticket still owns the sequence", () => {
    const instance = sandbox();
    const store = StateStore.open(join(instance.nullgHome, "state.db"), { create: true });
    try {
      store.registerConversation(UUID_A, {});
      const ticket = store.beginDelivery(UUID_A, 5);
      expect(store.rollbackDelivery(UUID_A, ticket)).toBe(true);
      expect(store.findByConversationId(UUID_A)?.watermarkStep).toBe(-1);
      const second = store.beginDelivery(UUID_A, 7);
      expect(store.rollbackDelivery(UUID_A, ticket)).toBe(false);
      expect(store.findByConversationId(UUID_A)?.watermarkStep).toBe(7);
      store.rollbackDelivery(UUID_A, second);
      store.setLastTurn(UUID_A, 4);
      store.setLastTurn(UUID_A, 4);
      expect(store.findByConversationId(UUID_A)?.lastTurn).toBe(4);
    } finally {
      store?.close();
    }
  });

  it("persists across reopen alongside the summaries database", () => {
    const instance = sandbox();
    initSummariesDb(instance);
    const path = join(instance.nullgHome, "state.db");
    const first = StateStore.open(path, { create: true });
    first?.registerConversation(UUID_A, { name: "alpha", cwd: "/tmp/repo", model: "flash" });
    first?.beginDelivery(UUID_A, 3);
    first?.close();

    const second = StateStore.open(path);
    try {
      expect(second?.findActiveByName("alpha")).toMatchObject({
        conversationId: UUID_A,
        cwd: "/tmp/repo",
        model: "flash",
        watermarkStep: 3,
      });
    } finally {
      second?.close();
    }
  });
});
