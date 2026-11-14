import { runCli } from "./cli/index";

const code = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
process.exitCode = code;

// `events` keeps a signal listener alive, so the runtime never drains on its own.
if (process.argv[2] === "events") {
  setTimeout(() => {
    process.exit(process.exitCode ?? 0);
  }, 50);
}
