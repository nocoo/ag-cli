import { existsSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { NullgError } from "../types/protocol";

export function assertInside(
  root: string,
  target: string,
  options: { hint?: string; mustExist?: boolean } = {},
): string {
  const absoluteTarget = resolve(target);
  if (options.mustExist && !existsSync(absoluteTarget)) {
    throw new NullgError("not_found", `path ${target} does not exist`, {
      hint: options.hint ?? "Paths must stay inside the expected directory.",
    });
  }
  const realRoot = realpathSync(root);
  const realTarget = existsSync(absoluteTarget)
    ? realpathSync(absoluteTarget)
    : resolve(realRoot, relative(root, absoluteTarget));
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
    throw new NullgError("invalid_usage", `path ${target} escapes ${root}`, {
      hint: options.hint ?? "Paths must stay inside the expected directory.",
    });
  }
  return realTarget;
}
