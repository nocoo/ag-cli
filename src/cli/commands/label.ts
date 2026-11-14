import { resolveTarget } from "../../domain/target-resolver";
import { resolvePaths } from "../../infra/paths";
import { StateStore } from "../../infra/state-store";
import { openSummariesReader } from "../../infra/summaries-reader";
import { AgCliError } from "../../types/protocol";
import { emitJson, emitText, resolveMode, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";
import { buildTargetRegistry, currentCallerId } from "./registry";

export async function runLabelCommand(
  args: string[],
  context: { env: Record<string, string | undefined>; stdout: StreamLike },
): Promise<number> {
  const flags = parseCommandFlags(args, { booleans: ["json"], values: [] });
  if (flags.positionals.length < 2) {
    if (flags.positionals.length === 0) {
      throw new AgCliError("invalid_usage", "label requires a target");
    }
    throw new AgCliError("invalid_usage", "label requires at least one key=value pair");
  }
  const target = flags.positionals[0] as string;
  const pairs = flags.positionals.slice(1);

  const paths = resolvePaths(context.env);
  const store = StateStore.open(paths.stateDbPath, { create: true });
  const reader = openSummariesReader(paths.summariesDbPath);
  try {
    const resolved = resolveTarget(target, buildTargetRegistry(paths, reader, store), {
      callerId: currentCallerId(context.env),
    });
    const row = store.ensureConversation(resolved.conversationId);
    store.setLabels(resolved.conversationId, pairs);
    const labels = Object.fromEntries(
      store.listLabels(resolved.conversationId).map((label) => [label.key, label.value]),
    );
    const payload = {
      conversationId: resolved.conversationId,
      shortId: `c${row.shortId}`,
      name: row.name,
      labels,
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
        `labels on c${row.shortId}: ${
          Object.entries(labels)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ") || "-"
        }`,
      );
    }
    return 0;
  } finally {
    reader?.close();
    store.close();
  }
}
