import { AgentApiClient } from "../../infra/agentapi-client";
import { resolvePaths } from "../../infra/paths";
import { AgCliError } from "../../types/protocol";
import { emitJson, emitText, renderTable, resolveMode, type StreamLike } from "../format";
import { parseCommandFlags } from "../index";

export async function runProjectsCommand(
  args: string[],
  context: { env: Record<string, string | undefined>; stdout: StreamLike },
): Promise<number> {
  const flags = parseCommandFlags(args, { booleans: ["json"], values: [] });
  if (flags.positionals.length !== 0) {
    throw new AgCliError("invalid_usage", "projects takes no positional arguments");
  }
  const paths = resolvePaths(context.env);
  const client = await AgentApiClient.connect({
    antigravityDir: paths.antigravityDir,
    agentapiBin: paths.agentapiBin,
    baseEnv: context.env,
  });
  const projects = await client.listProjects();

  const mode = resolveMode({
    json: flags.flags.has("json"),
    tty: context.stdout.isTTY === true,
    pipedIsJson: true,
  });
  if (mode === "json") {
    emitJson(context.stdout, projects);
  } else {
    emitText(
      context.stdout,
      renderTable(
        ["ID", "NAME", "FOLDERS"],
        projects.map((project) => [
          project.id,
          project.name || "-",
          project.folderUris.length === 0
            ? "-"
            : project.folderUris.map((uri) => uri.replace(/^file:\/\//, "")).join(", "),
        ]),
      ),
    );
  }
  return 0;
}
