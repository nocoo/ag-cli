import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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
const TEMPLATE_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

function stripInlineComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (
      char === "#" &&
      !inSingle &&
      !inDouble &&
      (index === 0 || value[index - 1] === " ")
    ) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseFrontmatter(raw: string): Record<string, string> {
  const lines = raw.split(/\r?\n/);
  const values: Record<string, string> = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    index += 1;
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 1) {
      throw new AgCliError("invalid_usage", `malformed template frontmatter line: ${line.trim()}`);
    }
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (rawValue === "|" || rawValue === ">") {
      const block: string[] = [];
      while (index < lines.length) {
        const next = lines[index] ?? "";
        if (next.trim().length > 0 && !/^\s/.test(next)) {
          break;
        }
        block.push(next.replace(/^\s{1,}/, ""));
        index += 1;
      }
      while (block.length > 0 && block[block.length - 1]?.trim() === "") {
        block.pop();
      }
      values[key] = rawValue === "|" ? block.join("\n") : block.join(" ");
      continue;
    }
    const value = stripInlineComment(rawValue);
    if (value.length === 0) {
      throw new AgCliError("invalid_usage", `template frontmatter key ${key} has no value`);
    }
    values[key] = unquote(value);
  }
  return values;
}

export function parseTemplate(text: string): ParsedTemplate {
  const match = FRONTMATTER_RE.exec(text);
  if (match === null) {
    if (/^---(\r?\n|$)/.test(text)) {
      throw new AgCliError("invalid_usage", "malformed template frontmatter");
    }
    return { preamble: text.trim() };
  }
  const values = parseFrontmatter(match[1] ?? "");
  const parsed: ParsedTemplate = { preamble: (match[2] ?? "").trim() };
  for (const [key, value] of Object.entries(values)) {
    if (!KNOWN_KEYS.has(key)) {
      continue;
    }
    if (value === "true" || value === "false" || /^\d+$/.test(value)) {
      throw new AgCliError("invalid_usage", `template field ${key} must be a string`);
    }
    parsed[key as keyof Omit<ParsedTemplate, "preamble">] = value;
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

function assertInside(root: string, target: string): void {
  const realRoot = realpathSync(root);
  const realTarget = existsSync(target) ? realpathSync(target) : resolve(target);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
    throw new AgCliError("invalid_usage", `path ${target} escapes ${root}`, {
      hint: "Templates must live inside the configured templates directory.",
    });
  }
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
  assertInside(join(configDir, "templates"), path);
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
