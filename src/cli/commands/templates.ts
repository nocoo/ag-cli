import { listTemplates } from "../../domain/template-parser";
import { resolvePaths } from "../../infra/paths";
import { AgCliError } from "../../types/protocol";
import { emitJson, emitText, renderTable, resolveMode, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";

export async function runTemplatesCommand(
  args: string[],
  context: { env: Record<string, string | undefined>; stdout: StreamLike },
): Promise<number> {
  const flags = parseCommandFlags(args, { booleans: ["json"], values: [] });
  if (flags.positionals.length !== 0) {
    throw new AgCliError("invalid_usage", "templates takes no positional arguments");
  }
  const paths = resolvePaths(context.env);
  const rows = listTemplates(paths.configDir).map((entry) => ({
    name: entry.template.name ?? entry.file,
    description: entry.template.description ?? "",
    model: entry.template.model ?? "",
    profile: entry.template.profile ?? "",
    cwd: entry.template.cwd ?? "",
  }));

  const mode = resolveMode({
    json: flags.flags.has("json"),
    tty: context.stdout.isTTY === true,
    pipedIsJson: true,
  });
  if (mode === "json") {
    emitJson(context.stdout, rows);
  } else {
    emitText(
      context.stdout,
      renderTable(
        ["NAME", "MODEL", "PROFILE", "DESCRIPTION"],
        rows.map((row) => [row.name, row.model, row.profile, row.description]),
      ),
    );
  }
  return 0;
}
