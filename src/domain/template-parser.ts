import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertInside } from "../infra/path-safety";
import { AgCliError } from "../types/protocol";

export interface ParsedTemplate {
  name?: string;
  description?: string;
  model?: string;
  profile?: string;
  cwd?: string;
  notify?: boolean;
  raw?: boolean;
  timeout?: number;
  preamble: string;
}

const STRING_FIELDS = ["name", "description", "model", "profile", "cwd"] as const;
const BOOLEAN_FIELDS = ["notify", "raw"] as const;
const TEMPLATE_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

export function parseTemplate(text: string): ParsedTemplate {
  const match = FRONTMATTER_RE.exec(text);
  if (match === null) {
    if (/^---(\r?\n|$)/.test(text)) {
      throw new AgCliError("invalid_usage", "malformed template frontmatter");
    }
    return { preamble: text.trim() };
  }
  let values: unknown;
  try {
    values = parseYaml(match[1] as string);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new AgCliError("invalid_usage", `malformed template frontmatter: ${reason}`);
  }
  if (values === null || values === undefined) {
    values = {};
  }
  if (typeof values !== "object" || Array.isArray(values)) {
    throw new AgCliError("invalid_usage", "template frontmatter must be a mapping");
  }
  const parsed: ParsedTemplate = { preamble: (match[2] as string).trim() };
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if ((STRING_FIELDS as readonly string[]).includes(key)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new AgCliError("invalid_usage", `template field ${key} must be a non-empty string`);
      }
      parsed[key as (typeof STRING_FIELDS)[number]] = value.replace(/\n+$/, "");
    } else if ((BOOLEAN_FIELDS as readonly string[]).includes(key)) {
      if (typeof value !== "boolean") {
        throw new AgCliError("invalid_usage", `template field ${key} must be a boolean`);
      }
      parsed[key as (typeof BOOLEAN_FIELDS)[number]] = value;
    } else if (key === "timeout") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new AgCliError(
          "invalid_usage",
          "template field timeout must be a non-negative integer",
        );
      }
      parsed.timeout = value;
    }
  }
  return parsed;
}

export function templatePath(configDir: string, name: string): string {
  if (
    !TEMPLATE_NAME_RE.test(name) ||
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new AgCliError("invalid_usage", `invalid template name ${name}`, {
      hint: "Template names match ^[a-zA-Z0-9._-]+$.",
    });
  }
  return join(configDir, "templates", `${name}.md`);
}

export function loadTemplate(
  configDir: string,
  name: string,
): { path: string; template: ParsedTemplate } {
  const path = templatePath(configDir, name);
  if (!existsSync(path)) {
    throw new AgCliError("not_found", `template ${name} not found`, {
      hint: "Run `ag-cli templates` to list installed templates.",
    });
  }
  assertInside(join(configDir, "templates"), path, {
    mustExist: true,
    hint: "Templates must live inside the configured templates directory.",
  });
  return { path, template: parseTemplate(readFileSync(path, "utf8")) };
}

export function listTemplates(
  configDir: string,
): Array<{ file: string; template: ParsedTemplate }> {
  const dir = join(configDir, "templates");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .flatMap((file) => {
      const path = join(dir, file);
      try {
        assertInside(dir, path, {
          mustExist: true,
          hint: "Templates must live inside the configured templates directory.",
        });
      } catch {
        return [];
      }
      return [
        { file: file.replace(/\.md$/, ""), template: parseTemplate(readFileSync(path, "utf8")) },
      ];
    });
}
