import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function skillManual(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "skill.md"), "utf8");
}
