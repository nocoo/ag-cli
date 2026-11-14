import { AgCliError, type ErrorKind } from "../types/protocol";

export interface ManagedConversation {
  shortId: number;
  conversationId: string;
  name: string | null;
  terminated: number;
}

export interface TargetRegistry {
  managed: ManagedConversation[];
  summaryIds: string[];
  brainIds: string[];
}

export type TargetVia = "name" | "shortId" | "uuidPrefix" | "uuid" | "caller";

export interface ResolvedTarget {
  conversationId: string;
  via: TargetVia;
  shortId?: number;
  name?: string;
}

export interface ResolveOptions {
  callerId?: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SHORT_ID_RE = /^c[0-9]+$/;
const HEX_PREFIX_RE = /^[0-9a-f]{4,}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(kind: ErrorKind, message: string, hint?: string): never {
  throw new AgCliError(kind, message, { hint });
}

export function resolveTarget(
  target: string | undefined,
  registry: TargetRegistry,
  options: ResolveOptions = {},
): ResolvedTarget {
  const trimmed = target?.trim() ?? "";
  if (trimmed.length === 0) {
    const callerId = options.callerId?.trim() ?? "";
    if (callerId.length > 0) {
      return resolveFullUuid(callerId.toLowerCase(), registry, "caller");
    }
    fail(
      "invalid_usage",
      "missing_target: no conversation target given and no caller conversation detected",
      "Pass a target like c7, a name, a UUID prefix, or run inside an Antigravity conversation.",
    );
  }

  const normalized = trimmed.toLowerCase();

  const byName = registry.managed.find((entry) => entry.name === trimmed && entry.terminated === 0);
  if (byName !== undefined) {
    return {
      conversationId: byName.conversationId,
      via: "name",
      shortId: byName.shortId,
      name: byName.name ?? undefined,
    };
  }

  if (SHORT_ID_RE.test(trimmed)) {
    const shortId = Number(normalized.slice(1));
    const byShortId = registry.managed.find((entry) => entry.shortId === shortId);
    if (byShortId === undefined) {
      fail("not_found", `no managed conversation with short id ${normalized}`);
    }
    return {
      conversationId: byShortId.conversationId,
      via: "shortId",
      shortId: byShortId.shortId,
      name: byShortId.name ?? undefined,
    };
  }

  if (UUID_RE.test(trimmed)) {
    return resolveFullUuid(normalized, registry, "uuid");
  }

  if (HEX_PREFIX_RE.test(trimmed)) {
    const pool = new Set<string>([
      ...registry.managed.map((entry) => entry.conversationId),
      ...registry.summaryIds,
      ...registry.brainIds,
    ]);
    const matches = [...pool].filter((id) => id.toLowerCase().startsWith(normalized));
    if (matches.length === 1) {
      const [conversationId] = matches as [string];
      const managed = registry.managed.find((entry) => entry.conversationId === conversationId);
      return {
        conversationId,
        via: "uuidPrefix",
        shortId: managed?.shortId,
        name: managed?.name ?? undefined,
      };
    }
    if (matches.length > 1) {
      fail(
        "ambiguous_target",
        `prefix ${normalized} matches ${matches.length} conversations: ${matches.join(", ")}`,
        "Use a longer prefix or the full UUID.",
      );
    }
    fail("not_found", `no conversation matches prefix ${normalized}`);
  }

  if (NAME_RE.test(trimmed)) {
    fail("not_found", `no active conversation named ${trimmed}`);
  }
  fail(
    "invalid_usage",
    `invalid target ${trimmed}`,
    "Targets are names ([a-z0-9][a-z0-9_-]{1,31}), short ids like c7, hex prefixes, or full UUIDs.",
  );
}

function resolveFullUuid(
  conversationId: string,
  registry: TargetRegistry,
  via: TargetVia,
): ResolvedTarget {
  const known =
    registry.managed.some((entry) => entry.conversationId === conversationId) ||
    registry.summaryIds.includes(conversationId) ||
    registry.brainIds.includes(conversationId);
  if (!known) {
    fail("not_found", `conversation ${conversationId} not found`);
  }
  const managed = registry.managed.find((entry) => entry.conversationId === conversationId);
  if (managed !== undefined && via === "caller") {
    return {
      conversationId,
      via,
      shortId: managed.shortId,
      name: managed.name ?? undefined,
    };
  }
  return {
    conversationId,
    via,
    shortId: managed?.shortId,
    name: managed?.name ?? undefined,
  };
}
