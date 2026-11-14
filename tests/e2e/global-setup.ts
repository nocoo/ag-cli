import { execFileSync } from "node:child_process";

export default function setup(): void {
  execFileSync("bun", ["run", "build"], { stdio: "inherit", cwd: process.cwd() });
}
