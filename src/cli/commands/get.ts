import { resolveTarget } from "../../domain/target-resolver";
import { resolvePaths } from "../../infra/paths";
import { StateStore } from "../../infra/state-store";
import { openSummariesReader } from "../../infra/summaries-reader";
import { emitJson, emitText, resolveMode, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";
import { buildTargetRegistry, currentCallerId, observeConversation } from "./registry";

export async function runGetCommand(
  args: string[],
  context: { env: Record<string, string | undefined>; stdout: StreamLike },
): Promise<number> {
  const flags = parseCommandFlags(args, { booleans: ["json"], values: [] });
  const paths = resolvePaths(context.env);
  const reader = openSummariesReader(paths.summariesDbPath);
  const store = StateStore.open(paths.stateDbPath);
  try {
    const target = resolveTarget(flags.positionals[0], buildTargetRegistry(paths, reader, store), {
      callerId: currentCallerId(context.env),
    });
    const observation = observeConversation(paths, reader, target.conversationId, store);
    const labels = Object.fromEntries(
      (store?.listLabels(target.conversationId) ?? []).map((label) => [label.key, label.value]),
    );
    const latestError = [...observation.steps].reverse().find((step) => step.status === "ERROR");

    const payload = {
      conversationId: observation.conversationId,
      shortId: observation.managed?.shortId ?? null,
      name: observation.managed?.name ?? null,
      title: observation.summary?.title ?? null,
      status: observation.status,
      turn: observation.turns.length,
      stepCount: observation.telemetry.stepCount,
      watermarkStep: observation.watermarkStep,
      parentId:
        observation.managed?.parentId ?? observation.summary?.parent_conversation_id ?? null,
      terminated: observation.managed?.terminated === 1,
      labels,
      telemetry: observation.telemetry,
      artifacts: observation.artifacts,
      ...(latestError === undefined ? {} : { latestError: latestError.content ?? "" }),
    };

    const mode = resolveMode({
      json: flags.flags.has("json"),
      tty: context.stdout.isTTY === true,
      pipedIsJson: true,
    });
    if (mode === "json") {
      emitJson(context.stdout, payload);
    } else {
      emitText(
        context.stdout,
        [
          `conversationId: ${payload.conversationId}`,
          `shortId: ${payload.shortId === null ? "-" : `c${payload.shortId}`}`,
          `name: ${payload.name ?? "-"}`,
          `title: ${payload.title ?? ""}`,
          `status: ${payload.status}`,
          `turn: ${payload.turn}`,
          `steps: ${payload.stepCount}`,
          `watermarkStep: ${payload.watermarkStep}`,
          `parentId: ${payload.parentId ?? "-"}`,
          `labels: ${
            Object.entries(labels)
              .map(([key, value]) => `${key}=${value}`)
              .join(" ") || "-"
          }`,
          `tokens: in ${observation.telemetry.inputTokens}, cache ${observation.telemetry.cacheReadTokens}, out ${observation.telemetry.outputTokens}`,
          `artifacts (${observation.artifacts.length}):`,
          ...observation.artifacts.map((artifact) => `- ${artifact.name} (${artifact.path})`),
        ].join("\n"),
      );
    }
    return 0;
  } finally {
    reader?.close();
    store?.close();
  }
}
