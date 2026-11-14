import { randomUUID } from "node:crypto";
import { type CallerContext, detectCallerContext, wrapOutboundPrompt } from "../../domain/envelope";
import { resolveTarget } from "../../domain/target-resolver";
import { loadTemplate, type ParsedTemplate } from "../../domain/template-parser";
import { maxStepIndex } from "../../domain/transcript-parser";
import { assertAlias } from "../../domain/validation";
import { AgentApiClient } from "../../infra/agentapi-client";
import { resolvePaths } from "../../infra/paths";
import { StateStore } from "../../infra/state-store";
import { openSummariesReader } from "../../infra/summaries-reader";
import { AgCliError } from "../../types/protocol";
import { emitJson, emitText, resolveMode, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";
import { awaitSettledStatus } from "./await-settled";
import {
  buildTargetRegistry,
  currentCallerId,
  loadTranscriptSteps,
  observeConversation,
} from "./registry";

export interface RunSummary {
  shortId: string | null;
  conversationId: string;
  name: string | null;
  title: string;
  reused: boolean;
  model: string;
  projectId: string | null;
  cwd: string;
  parentId: string | null;
  watermarkStep: number;
  status: string;
}

function callerWithContext(caller: CallerContext | null, store: StateStore): CallerContext | null {
  if (caller === null) {
    return null;
  }
  if (caller.kind !== "ag-cli") {
    return caller;
  }
  const row = store.findByConversationId(caller.conversationId);
  return {
    ...caller,
    shortId: row?.shortId,
    name: row?.name ?? undefined,
  };
}

const RESERVATION_RETRY_MS = 50;

async function acquireReservation(
  store: StateStore,
  name: string,
  token: string,
  waitUpToMs: number,
): Promise<boolean> {
  const deadline = Date.now() + waitUpToMs;
  for (;;) {
    if (store.acquireNameReservation(name, token)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, RESERVATION_RETRY_MS));
  }
}

export async function runRunCommand(
  args: string[],
  context: { env: Record<string, string | undefined>; stdout: StreamLike; stderr: StreamLike },
): Promise<number> {
  const flags = parseCommandFlags(args, {
    booleans: ["bg", "reuse", "no-parent", "no-notify", "raw", "json"],
    values: ["name", "cwd", "model", "profile", "title", "timeout", "parent"],
    repeatables: ["label"],
  });
  if (flags.positionals.length === 0) {
    throw new AgCliError("invalid_usage", "run requires a prompt");
  }
  let prompt = flags.positionals[0] as string;
  let templateDefaults: ParsedTemplate | undefined;
  if (flags.positionals.length > 2) {
    throw new AgCliError("invalid_usage", "run accepts at most a template and a prompt");
  }
  if (flags.positionals.length > 1) {
    const templateName = flags.positionals[0] as string;
    prompt = flags.positionals[1] as string;
    templateDefaults = loadTemplate(resolvePaths(context.env).configDir, templateName).template;
  }
  const name = flags.values.get("name");
  if (name !== undefined) {
    assertAlias(name);
  }
  if (flags.flags.has("reuse") && name === undefined) {
    throw new AgCliError("invalid_usage", "--reuse requires --name");
  }
  const timeoutSec = parseTimeout(flags.values.get("timeout"));
  const labelPairs = flags.repeatable.get("label") ?? [];
  for (const pair of labelPairs) {
    if (pair.indexOf("=") < 1) {
      throw new AgCliError("invalid_usage", `invalid label ${pair}`, {
        hint: "Use --label key=value.",
      });
    }
  }

  const paths = resolvePaths(context.env);
  const store = StateStore.open(paths.stateDbPath, { create: true });
  const reader = openSummariesReader(paths.summariesDbPath);
  const reservationToken = randomUUID();
  let reservationHeld = false;
  try {
    const caller = callerWithContext(detectCallerContext(context.env), store);
    let parentId: string | null = null;
    if (flags.flags.has("no-parent")) {
      parentId = null;
    } else if (flags.values.has("parent")) {
      parentId = resolveParent(
        flags.values.get("parent") as string,
        paths,
        reader,
        store,
        context.env,
      );
    } else if (caller?.kind === "ag-cli") {
      parentId = caller.conversationId;
    } else if (caller?.kind === "hc") {
      parentId = `hc:${caller.terminalId}`;
    }

    const cwd = flags.values.get("cwd") ?? templateDefaults?.cwd ?? process.cwd();
    const model = flags.values.get("model") ?? templateDefaults?.model ?? "flash";
    const client = await AgentApiClient.connect({
      antigravityDir: paths.antigravityDir,
      agentapiBin: paths.agentapiBin,
      baseEnv: context.env,
    });
    let projectId: string | null = null;
    try {
      projectId = await client.resolveProjectIdForCwd(cwd);
    } catch {
      projectId = null;
    }

    const combinedPrompt =
      templateDefaults === undefined || templateDefaults.preamble.length === 0
        ? prompt
        : `${templateDefaults.preamble}\n\n${prompt}`;
    const message = wrapOutboundPrompt(combinedPrompt, caller, {
      cwd,
      noNotify: flags.flags.has("no-notify"),
      raw: flags.flags.has("raw"),
    });

    if (name !== undefined) {
      if (flags.flags.has("reuse")) {
        const waitLimitMs = Math.max(3000, Math.min(timeoutSec * 1000, 10_000));
        // release stale aliases left on terminated rows before deciding
        for (const row of store.listManaged()) {
          if (row.name === name && row.terminated === 1) {
            store.releaseName(row.conversationId);
          }
        }
        reservationHeld = await acquireReservation(store, name, reservationToken, waitLimitMs);
      } else {
        const holder = store.listManaged().find((row) => row.name === name);
        if (holder !== undefined) {
          throw new AgCliError("name_conflict", `name ${name} is already in use`, {
            hint: "Pick another name, use --reuse, or ag-cli rm the old conversation.",
          });
        }
        if (!store.acquireNameReservation(name, reservationToken)) {
          throw new AgCliError("name_conflict", `name ${name} is already being created`, {
            hint: "Another run is creating this name right now; retry shortly.",
          });
        }
        reservationHeld = true;
      }
    }

    if (flags.flags.has("reuse") && name !== undefined) {
      const existing = store.findActiveByName(name);
      const upstreamKilled =
        existing === undefined
          ? false
          : (reader?.getConversation(existing.conversationId)?.killed ?? 0) === 1;
      if (existing !== undefined && upstreamKilled) {
        store.markTerminated(existing.conversationId);
      }
      if (existing !== undefined && !upstreamKilled) {
        const prevMax = maxStepIndex(
          loadTranscriptSteps(paths.antigravityDir, existing.conversationId),
        );
        const watermarkStep = prevMax + 1;
        const ticket = store.beginDelivery(existing.conversationId, watermarkStep);
        try {
          await client.sendMessage(existing.conversationId, message, {
            title: flags.values.get("title"),
            projectId: projectId ?? undefined,
          });
          store.commitDelivery(existing.conversationId, ticket);
        } catch (error) {
          store.rollbackDelivery(existing.conversationId, ticket);
          throw error;
        }
        if (labelPairs.length > 0) {
          store.setLabels(existing.conversationId, labelPairs);
        }
        return await finishRun({
          flags,
          context,
          paths,
          reader,
          store,
          timeoutSec,
          summary: {
            shortId: `c${existing.shortId}`,
            conversationId: existing.conversationId,
            name: existing.name,
            title: existing.name as string,
            reused: true,
            model: existing.model ?? model,
            projectId: existing.projectId,
            cwd: existing.cwd ?? cwd,
            parentId: existing.parentId,
            watermarkStep,
            status: "",
          },
        });
      }
    }

    if (flags.flags.has("reuse") && name !== undefined && !reservationHeld) {
      // no active conversation holds the name and another process still owns the
      // reservation: dispatching here would duplicate the in-flight creation
      throw new AgCliError("name_conflict", `name ${name} is still being created by another run`, {
        hint: "Retry once the other run finishes, or pick another name.",
      });
    }

    const title = flags.values.get("title") ?? name ?? prompt.slice(0, 40);
    const created = await client.newConversation({
      message,
      title,
      profile: flags.values.get("profile") ?? templateDefaults?.profile,
      model,
      projectId: projectId ?? undefined,
    });
    const row = store.registerConversation(created.conversationId, {
      ...(name === undefined ? {} : { name }),
      ...(parentId === null ? {} : { parentId }),
      cwd,
      ...(projectId === null ? {} : { projectId }),
      model,
    });
    store.commitDelivery(created.conversationId, store.beginDelivery(created.conversationId, 0));
    if (labelPairs.length > 0) {
      store.setLabels(created.conversationId, labelPairs);
    }

    return await finishRun({
      flags,
      context,
      paths,
      reader,
      store,
      timeoutSec,
      summary: {
        shortId: `c${row.shortId}`,
        conversationId: created.conversationId,
        name: row.name,
        title,
        reused: false,
        model,
        projectId,
        cwd,
        parentId,
        watermarkStep: 0,
        status: "",
      },
    });
  } finally {
    if (reservationHeld && name !== undefined) {
      store.releaseNameReservation(name, reservationToken);
    }
    reader?.close();
    store.close();
  }
}

function resolveParent(
  parent: string,
  paths: ReturnType<typeof resolvePaths>,
  reader: ReturnType<typeof openSummariesReader>,
  store: StateStore,
  env: Record<string, string | undefined>,
): string {
  return resolveTarget(parent, buildTargetRegistry(paths, reader, store), {
    callerId: currentCallerId(env),
  }).conversationId;
}

async function finishRun(options: {
  flags: ReturnType<typeof parseCommandFlags>;
  context: { env: Record<string, string | undefined>; stdout: StreamLike; stderr: StreamLike };
  paths: ReturnType<typeof resolvePaths>;
  reader: ReturnType<typeof openSummariesReader>;
  store: StateStore;
  timeoutSec: number;
  summary: RunSummary;
}): Promise<number> {
  const { flags, context, paths, reader, store, timeoutSec, summary } = options;
  const observation = observeConversation(paths, reader, summary.conversationId, store);
  summary.status = observation.status;

  if (!flags.flags.has("bg")) {
    const outcome = await awaitSettledStatus({
      paths,
      reader,
      store,
      conversationId: summary.conversationId,
      timeoutSec,
    });
    summary.status = outcome.status;
    if (outcome.timedOut) {
      const timeoutMode = resolveMode({
        json: flags.flags.has("json"),
        tty: context.stdout.isTTY === true,
        pipedIsJson: true,
      });
      if (timeoutMode === "json") {
        emitJson(context.stdout, {
          ...summary,
          reason: "timeout",
          timedOut: true,
          durationMs: outcome.durationMs,
        });
      } else {
        const label = summary.shortId ?? summary.conversationId.slice(0, 8);
        const named =
          summary.name === null
            ? `, ${summary.conversationId.slice(0, 8)}`
            : ` (${summary.name}, ${summary.conversationId.slice(0, 8)})`;
        emitText(context.stderr, `[ag-cli] still working as ${label}${named}`);
      }
      return 124;
    }
  }

  const mode = resolveMode({
    json: flags.flags.has("json"),
    tty: context.stdout.isTTY === true,
    pipedIsJson: false,
  });
  if (mode === "json") {
    emitJson(context.stdout, summary);
  } else {
    const label = summary.shortId ?? summary.conversationId.slice(0, 8);
    emitText(
      context.stdout,
      [
        `${label}${summary.name === null ? "" : ` (${summary.name})`} · ${summary.status}${summary.reused ? " · reused" : ""}`,
        `conversationId: ${summary.conversationId}`,
        `watermark: ${summary.watermarkStep}`,
      ].join("\n"),
    );
  }
  return 0;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) {
    return 180;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new AgCliError("invalid_usage", `--timeout expects a non-negative integer, got ${raw}`);
  }
  return value;
}
