export interface SchemaOption {
  name: string;
  kind: "boolean" | "string" | "integer" | "repeat";
  default?: string;
}

export interface SchemaCommand {
  name: string;
  args?: string;
  options: SchemaOption[];
  output: string;
}

export const CLI_SCHEMA: {
  cli: string;
  exitCodes: Record<string, number>;
  reasons: string[];
  commands: SchemaCommand[];
} = {
  cli: "ag-cli",
  exitCodes: {
    ok: 0,
    failure: 1,
    invalidUsage: 2,
    preconditionFailed: 3,
    daemonUnavailable: 4,
    timeout: 124,
  },
  reasons: ["done", "blocked", "error", "message", "timeout"],
  commands: [
    {
      name: "run",
      args: "[template] <prompt>",
      options: [
        { name: "--bg", kind: "boolean" },
        { name: "--name", kind: "string" },
        { name: "--reuse", kind: "boolean" },
        { name: "--cwd", kind: "string" },
        { name: "--model", kind: "string", default: "flash" },
        { name: "--profile", kind: "string" },
        { name: "--title", kind: "string" },
        { name: "--label", kind: "repeat" },
        { name: "--parent", kind: "string" },
        { name: "--no-parent", kind: "boolean" },
        { name: "--no-notify", kind: "boolean" },
        { name: "--raw", kind: "boolean" },
        { name: "--timeout", kind: "integer", default: "180" },
        { name: "--json", kind: "boolean" },
      ],
      output:
        "summary object (shortId, conversationId, name, title, reused, model, projectId, cwd, watermarkStep, status)",
    },
    {
      name: "send",
      args: "<c> <text>",
      options: [
        { name: "--if", kind: "string" },
        { name: "--force", kind: "boolean" },
        { name: "--wait", kind: "boolean" },
        { name: "--timeout", kind: "integer", default: "180" },
        { name: "--title", kind: "string" },
        { name: "--no-notify", kind: "boolean" },
        { name: "--raw", kind: "boolean" },
        { name: "--json", kind: "boolean" },
      ],
      output:
        "receipt object (conversationId, shortId, name, watermarkStep, queued, reason?, status?, durationMs?)",
    },
    {
      name: "wait",
      args: "[c]",
      options: [
        { name: "--children", kind: "string" },
        { name: "--timeout", kind: "integer", default: "180" },
        { name: "--json", kind: "boolean" },
      ],
      output: "wait object (reason, target, durationMs, latestReplyPreview, children?)",
    },
    {
      name: "read",
      args: "[c]",
      options: [
        { name: "--turns", kind: "integer", default: "1" },
        { name: "--steps", kind: "boolean" },
        { name: "--lines", kind: "integer", default: "50" },
        { name: "--full", kind: "boolean" },
        { name: "--artifact", kind: "string" },
        { name: "--json", kind: "boolean" },
      ],
      output: "reply object (conversationId, status, turn, reply, turns, artifacts, telemetry)",
    },
    {
      name: "ls",
      options: [
        { name: "--all", kind: "boolean" },
        { name: "--label", kind: "repeat" },
        { name: "--children", kind: "boolean" },
        { name: "--status", kind: "string" },
        { name: "--json", kind: "boolean" },
      ],
      output: "array of conversation rows",
    },
    {
      name: "get",
      args: "[c]",
      options: [{ name: "--json", kind: "boolean" }],
      output:
        "observed snapshot (ids, status, watermarkStep, labels, telemetry, artifacts, latestError?)",
    },
    {
      name: "label",
      args: "<c> <k=v...>",
      options: [{ name: "--json", kind: "boolean" }],
      output: "labels object",
    },
    {
      name: "kill",
      args: "<c>",
      options: [{ name: "--json", kind: "boolean" }],
      output: "termination receipt",
    },
    {
      name: "rm",
      args: "<c>",
      options: [
        { name: "--purge-brain", kind: "boolean" },
        { name: "--json", kind: "boolean" },
      ],
      output: "removal receipt (removed, purgedBrain)",
    },
    {
      name: "interrupt",
      args: "<c>",
      options: [{ name: "--json", kind: "boolean" }],
      output: "interruption receipt",
    },
    {
      name: "templates",
      options: [{ name: "--json", kind: "boolean" }],
      output: "array of templates",
    },
    {
      name: "events",
      options: [
        { name: "--target", kind: "string" },
        { name: "--children-of", kind: "string" },
        { name: "--label", kind: "repeat" },
        { name: "--heartbeat-ms", kind: "integer", default: "15000" },
      ],
      output: "NDJSON stream (state, step, terminal, heartbeat)",
    },
    {
      name: "status",
      options: [{ name: "--json", kind: "boolean" }],
      output: "health report (daemon, summaries, agentapi, stateDb)",
    },
    {
      name: "schema",
      options: [],
      output: "this document",
    },
  ],
};
