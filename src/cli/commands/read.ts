import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTarget } from "../../domain/target-resolver";
import { latestReply, mergeFullSteps, type TranscriptStep } from "../../domain/transcript-parser";
import { assertInside } from "../../infra/path-safety";
import { resolvePaths } from "../../infra/paths";
import { StateStore } from "../../infra/state-store";
import { openSummariesReader } from "../../infra/summaries-reader";
import { AgCliError } from "../../types/protocol";
import { emitJson, emitText, resolveMode, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";
import {
  buildTargetRegistry,
  currentCallerId,
  loadFullTranscriptSteps,
  observeConversation,
} from "./registry";

export function renderStepLines(steps: TranscriptStep[]): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    const type = step.type ?? "GENERIC";
    if (type === "USER_INPUT" || type === "SYSTEM_MESSAGE") {
      lines.push(`[system] ${type} ${step.content ?? ""}`.trimEnd());
      continue;
    }
    if (type === "PLANNER_RESPONSE") {
      lines.push(`[reply] ${step.content ?? ""}`.trimEnd());
      continue;
    }
    const hasThinking = typeof step.thinking === "string" && step.thinking.length > 0;
    const toolCalls = step.tool_calls ?? [];
    if (hasThinking) {
      lines.push(`[think] ${step.thinking}`);
    }
    for (const toolCall of toolCalls) {
      const name = toolCall.name ?? "";
      const status = toolCall.status ?? "";
      lines.push(status === "" ? `[tool] ${name}` : `[tool] ${name} (${status})`);
    }
    if (!hasThinking && toolCalls.length === 0) {
      lines.push(`[think] ${step.content ?? ""}`.trimEnd());
    }
  }
  return lines;
}

export async function runReadCommand(
  args: string[],
  context: { env: Record<string, string | undefined>; stdout: StreamLike },
): Promise<number> {
  const flags = parseCommandFlags(args, {
    booleans: ["json", "steps", "full"],
    values: ["turns", "lines", "artifact"],
  });
  const turnsLimit = parsePositiveInt(flags.values.get("turns"), 1, "turns");
  const linesLimit = parsePositiveInt(flags.values.get("lines"), 50, "lines");
  const paths = resolvePaths(context.env);
  const reader = openSummariesReader(paths.summariesDbPath);
  const store = StateStore.open(paths.stateDbPath);
  try {
    const target = resolveTarget(flags.positionals[0], buildTargetRegistry(paths, reader, store), {
      callerId: currentCallerId(context.env),
    });

    if (flags.values.has("artifact")) {
      const name = flags.values.get("artifact") as string;
      const conversationDir = join(paths.brainDir, target.conversationId);
      const path = join(conversationDir, name);
      if (!existsSync(path)) {
        throw new AgCliError("not_found", `artifact ${name} not found in ${target.conversationId}`);
      }
      assertInside(conversationDir, path, "Artifacts must stay inside the conversation brain dir.");
      context.stdout.write(readFileSync(path, "utf8"));
      return 0;
    }

    const observation = observeConversation(paths, reader, target.conversationId, store);
    const steps = flags.flags.has("full")
      ? mergeFullSteps(
          observation.steps,
          loadFullTranscriptSteps(paths.antigravityDir, target.conversationId),
        )
      : observation.steps;
    const reply = latestReply(steps)?.content ?? "";
    const recentTurns = observation.turns.slice(-turnsLimit);

    const mode = resolveMode({
      json: flags.flags.has("json"),
      tty: context.stdout.isTTY === true,
      pipedIsJson: false,
    });
    if (mode === "json") {
      emitJson(context.stdout, {
        conversationId: target.conversationId,
        shortId:
          observation.managed === undefined || observation.managed === null
            ? null
            : `c${observation.managed.shortId}`,
        name: observation.managed?.name ?? null,
        parentId:
          observation.managed?.parentId ?? observation.summary?.parent_conversation_id ?? null,
        labels: Object.fromEntries(
          (store?.listLabels(target.conversationId) ?? []).map((label) => [label.key, label.value]),
        ),
        status: observation.status,
        turn: recentTurns.length,
        reply,
        turns: recentTurns.map((turn) => ({
          turn: turn.inboundStepIndex,
          inboundType: turn.inboundType,
          reply: latestReply(turn.steps)?.content ?? "",
        })),
        ...(flags.flags.has("steps") ? { steps } : {}),
        artifacts: observation.artifacts,
        telemetry: observation.telemetry,
      });
      return 0;
    }

    if (flags.flags.has("steps")) {
      const lines = renderStepLines(steps).slice(-linesLimit);
      emitText(context.stdout, lines.join("\n"));
      return 0;
    }

    if (context.stdout.isTTY === true) {
      const label =
        target.shortId !== undefined ? `c${target.shortId}` : target.conversationId.slice(0, 8);
      emitText(
        context.stdout,
        [
          `# ${label}${target.name !== undefined ? ` (${target.name})` : ""} · Turn ${observation.turns.length} · ${observation.status}`,
          "",
          reply,
          "---",
          `Artifacts (${observation.artifacts.length}):`,
          ...observation.artifacts.map((artifact) => `- ${artifact.name}  (${artifact.path})`),
        ].join("\n"),
      );
      return 0;
    }

    emitText(context.stdout, reply);
    return 0;
  } finally {
    reader?.close();
    store?.close();
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new AgCliError("invalid_usage", `--${name} expects a positive integer, got ${raw}`);
  }
  return value;
}
