import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgCliError } from "../types/protocol";

export interface ParsedTemplate {
  name?: string;
  description?: string;
  model?: string;
  profile?: string;
  cwd?: string;
  preamble: string;
}

const KNOWN_KEYS = new Set(["name", "description", "model", "profile", "cwd"]);
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseTemplate(text: string): ParsedTemplate {
  const match = FRONTMATTER_RE.exec(text);
  if (match === null) {
    return { preamble: text.trim() };
  }
  const frontmatter = match[1] ?? "";
  const parsed: ParsedTemplate = { preamble: (match[2] ?? "").trim() };
  for (const line of frontmatter.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (KNOWN_KEYS.has(key) && value.length > 0) {
      parsed[key as keyof Omit<ParsedTemplate, "preamble">] = value;
    }
  }
  return parsed;
}

export function templatePath(configDir: string, name: string): string {
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
    .map((file) => ({
      file: file.replace(/\.md$/, ""),
      template: parseTemplate(readFileSync(join(dir, file), "utf8")),
    }));
}
