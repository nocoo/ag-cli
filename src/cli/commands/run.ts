import { type CallerContext, detectCallerContext, wrapOutboundPrompt } from "../../domain/envelope";
import { resolveTarget } from "../../domain/target-resolver";
import { loadTemplate, type ParsedTemplate } from "../../domain/template-parser";
import { maxStepIndex } from "../../domain/transcript-parser";
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
  shortId: number | null;
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
  if (flags.positionals.length > 1) {
    const templateName = flags.positionals[0] as string;
    prompt = flags.positionals[1] as string;
    templateDefaults = loadTemplate(resolvePaths(context.env).configDir, templateName).template;
  }
  const name = flags.values.get("name");
  if (flags.flags.has("reuse") && name === undefined) {
    throw new AgCliError("invalid_usage", "--reuse requires --name");
  }
  const timeoutSec = parseTimeout(flags.values.get("timeout"));

  const paths = resolvePaths(context.env);
  const store = StateStore.open(paths.stateDbPath, { create: true });
  const reader = openSummariesReader(paths.summariesDbPath);
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

    if (flags.flags.has("reuse") && name !== undefined) {
      const existing = store.findActiveByName(name);
      if (existing !== undefined) {
        const prevMax = maxStepIndex(
          loadTranscriptSteps(paths.antigravityDir, existing.conversationId),
        );
        const watermarkStep = prevMax + 1;
        store.updateWatermark(existing.conversationId, watermarkStep);
        await client.sendMessage(existing.conversationId, message);
        return await finishRun({
          flags,
          context,
          paths,
          reader,
          store,
          timeoutSec,
          summary: {
            shortId: existing.shortId,
            conversationId: existing.conversationId,
            name: existing.name,
            title: existing.name ?? prompt.slice(0, 40),
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

    if (name !== undefined && !flags.flags.has("reuse")) {
      const holder = store.listManaged().find((row) => row.name === name);
      if (holder !== undefined) {
        throw new AgCliError("name_conflict", `name ${name} is already in use`, {
          hint: "Pick another name, use --reuse, or ag-cli rm the old conversation.",
        });
      }
    }

    const title = flags.values.get("title") ?? name ?? prompt.slice(0, 40);
    const created = await client.newConversation({
      message,
      title,
      profile: flags.values.get("profile") ?? templateDefaults?.profile,
    });
    const row = store.registerConversation(created.conversationId, {
      ...(name === undefined ? {} : { name }),
      ...(parentId === null ? {} : { parentId }),
      cwd,
      ...(projectId === null ? {} : { projectId }),
      model,
    });
    store.updateWatermark(created.conversationId, 0);
    const labelPairs = flags.repeatable.get("label") ?? [];
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
        shortId: row.shortId,
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
      const label =
        summary.shortId === null ? summary.conversationId.slice(0, 8) : `c${summary.shortId}`;
      const named =
        summary.name === null ? "" : ` (${summary.name}, ${summary.conversationId.slice(0, 8)})`;
      emitText(
        context.stderr,
        `[ag-cli] still working as ${label}${named || `, ${summary.conversationId.slice(0, 8)}`}`,
      );
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
    const label =
      summary.shortId === null ? summary.conversationId.slice(0, 8) : `c${summary.shortId}`;
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
