import { existsSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { AgCliError } from "../types/protocol";

export function assertInside(root: string, target: string, hint?: string): string {
  const realRoot = realpathSync(root);
  const absoluteTarget = resolve(target);
  const realTarget = existsSync(absoluteTarget)
    ? realpathSync(absoluteTarget)
    : resolve(realRoot, relative(root, absoluteTarget));
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
    throw new AgCliError("invalid_usage", `path ${target} escapes ${root}`, {
      hint: hint ?? "Paths must stay inside the expected directory.",
    });
  }
  return realTarget;
}
