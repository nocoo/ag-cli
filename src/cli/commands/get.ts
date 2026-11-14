import { resolveTarget } from "../../domain/target-resolver";
import { resolvePaths } from "../../infra/paths";
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
  try {
    const target = resolveTarget(flags.positionals[0], buildTargetRegistry(paths, reader), {
      callerId: currentCallerId(context.env),
    });
    const observation = observeConversation(paths, reader, target.conversationId);
    const latestError = [...observation.steps].reverse().find((step) => step.status === "ERROR");

    const payload = {
      conversationId: observation.conversationId,
      shortId: target.shortId ?? null,
      name: target.name ?? null,
      title: observation.summary?.title ?? null,
      status: observation.status,
      turn: observation.turns.length,
      stepCount: observation.telemetry.stepCount,
      watermarkStep: observation.watermarkStep,
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
          `title: ${payload.title ?? ""}`,
          `status: ${payload.status}`,
          `turn: ${payload.turn}`,
          `steps: ${payload.stepCount}`,
          `watermarkStep: ${payload.watermarkStep}`,
          `tokens: in ${observation.telemetry.inputTokens}, cache ${observation.telemetry.cacheReadTokens}, out ${observation.telemetry.outputTokens}`,
          `artifacts (${observation.artifacts.length}):`,
          ...observation.artifacts.map((artifact) => `- ${artifact.name} (${artifact.path})`),
        ].join("\n"),
      );
    }
    return 0;
  } finally {
    reader?.close();
  }
}
