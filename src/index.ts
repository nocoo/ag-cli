import { runCli } from "./cli/index";

const code = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
process.exitCode = code;
