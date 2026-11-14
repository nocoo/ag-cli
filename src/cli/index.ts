import { AgCliError } from "../types/protocol";
import { runControlCommand } from "./commands/control";
import { runEventsCommand } from "./commands/events";
import { runGetCommand } from "./commands/get";
import { runLabelCommand } from "./commands/label";
import { runLsCommand } from "./commands/ls";
import { runReadCommand } from "./commands/read";
import { runRunCommand } from "./commands/run";
import { runSendCommand } from "./commands/send";
import { runStatusCommand } from "./commands/status";
import { runTemplatesCommand } from "./commands/templates";
import { runWaitCommand } from "./commands/wait";
import { emitError, emitJson, emitText, resolveMode, type StreamLike } from "./format";
import { CLI_SCHEMA } from "./schema";
import { skillManual } from "./skill";

export interface CliContext {
  stdout: StreamLike;
  stderr: StreamLike;
  env: Record<string, string | undefined>;
}

export interface ParsedFlags {
  flags: Set<string>;
  values: Map<string, string>;
  repeatable: Map<string, string[]>;
  positionals: string[];
}

const USAGE = `ag-cli - dispatch tasks to local Antigravity conversations and collect results

Usage: ag-cli <command> [options]

Conversations
  run [prompt]                Start (or --reuse) a conversation and wait (--bg: don't wait)
  ls                          List active conversations (--all: include killed/unmanaged)
  get [c]                     Show observed state, status, tokens, and artifacts
  read [c]                    Print the latest reply and artifacts (--steps: show trace)
  label <c> <k=v...>          Set or clear labels (key= removes)
  kill <c>                    Cancel a running turn or mark conversation terminated
  rm <c>                      Remove a conversation from registry (--purge-brain: delete files)

Talk & Wait
  send <c> <text>             Send a message to a conversation (--wait: wait for turn)
  wait [c]                    Wait until done, blocked, or error (--children: any|all)
  interrupt <c>               Cancel the currently running turn in a conversation

More
  status                      Inspect Antigravity daemon, database, and agentapi health
  events                      Follow state and step changes live (JSON Lines when piped)
  templates                   List templates (~/.config/ag-cli/templates)
  schema                      Print the CLI/API JSON Schema

Run ag-cli --skill for the embedded agent manual.

<c> is a target like c7, a name (clip-worker), a UUID prefix, or a full UUID.
Piped output is JSON except run (text summary) and read (Markdown reply).
Use ag-cli --help to list commands.`;

export function parseCommandFlags(
  args: string[],
  spec: { booleans: string[]; values: string[]; repeatables?: string[] },
): ParsedFlags {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const repeatable = new Map<string, string[]>();
  const positionals: string[] = [];
  let skipNext = false;
  let positionalOnly = false;
  for (const [index, arg] of args.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (positionalOnly || arg === "--") {
      if (arg === "--") {
        positionalOnly = true;
      } else {
        positionals.push(arg);
      }
      continue;
    }
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (spec.booleans.includes(name)) {
        flags.add(name);
      } else if (spec.values.includes(name) || (spec.repeatables ?? []).includes(name)) {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new AgCliError("invalid_usage", `--${name} expects a value`);
        }
        if (spec.values.includes(name)) {
          values.set(name, value);
        } else {
          const existing = repeatable.get(name) ?? [];
          existing.push(value);
          repeatable.set(name, existing);
        }
        skipNext = true;
      } else {
        throw new AgCliError("invalid_usage", `unknown option --${name}`);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, values, repeatable, positionals };
}

export async function runCli(argv: string[], context: CliContext): Promise<number> {
  const command = argv[0];
  const args = argv.slice(1);
  try {
    if (command === "--help" || command === "help") {
      emitText(context.stdout, USAGE);
      return 0;
    }
    if (command === "--skill" || command === "skill") {
      emitText(context.stdout, skillManual());
      return 0;
    }
    if (command === "schema") {
      emitJson(context.stdout, CLI_SCHEMA);
      return 0;
    }
    if (command === undefined) {
      const mode = resolveMode({
        json: argv.includes("--json"),
        tty: context.stdout.isTTY === true,
        pipedIsJson: true,
      });
      if (mode === "json") {
        emitError(
          context.stderr,
          new AgCliError("invalid_usage", "missing command", { hint: "Run ag-cli --help." }),
          "json",
        );
      } else {
        emitText(context.stderr, USAGE);
      }
      return 2;
    }
    if (args.includes("--help") || args.includes("-h")) {
      emitText(
        context.stdout,
        `Usage: ag-cli ${command} [options]\n\nRun ag-cli --help for the full command list.`,
      );
      return 0;
    }
    if (command === "status" || command === "doctor") {
      return await runStatusCommand(args, context);
    }
    if (command === "templates") {
      return await runTemplatesCommand(args, context);
    }
    if (command === "ls") {
      return await runLsCommand(args, context);
    }
    if (command === "get") {
      return await runGetCommand(args, context);
    }
    if (command === "read") {
      return await runReadCommand(args, context);
    }
    if (command === "run") {
      return await runRunCommand(args, context);
    }
    if (command === "send") {
      return await runSendCommand(args, context);
    }
    if (command === "label") {
      return await runLabelCommand(args, context);
    }
    if (command === "wait") {
      return await runWaitCommand(args, context);
    }
    if (command === "events") {
      return await runEventsCommand(args, context);
    }
    if (command === "interrupt" || command === "kill" || command === "rm") {
      return await runControlCommand(command, args, context);
    }
    throw new AgCliError("invalid_usage", `unknown command ${command}`, {
      hint: "Run ag-cli --help.",
    });
  } catch (error) {
    const mode = resolveMode({
      json: argv.includes("--json"),
      tty: context.stdout.isTTY === true,
      pipedIsJson: true,
    });
    emitError(context.stderr, error, mode);
    return error instanceof AgCliError ? error.exitCode : 1;
  }
}
