interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: string[];
  const?: string;
  $ref?: string;
  additionalProperties?: boolean;
  description?: string;
}

const nullableString: JsonSchema = { type: ["string", "null"] as unknown as string };

function objectSchema(properties: Record<string, JsonSchema>, required?: string[]): JsonSchema {
  return {
    type: "object",
    ...(required === undefined ? {} : { required }),
    properties,
    additionalProperties: false,
  };
}

const TYPES = {
  runSummary: objectSchema(
    {
      shortId: nullableString,
      conversationId: { type: "string" },
      name: nullableString,
      title: { type: "string" },
      reused: { type: "boolean" },
      model: { type: "string" },
      projectId: nullableString,
      cwd: { type: "string" },
      parentId: nullableString,
      watermarkStep: { type: "integer" },
      status: { enum: ["idle", "working", "done", "blocked", "error"] },
    },
    ["conversationId", "reused", "watermarkStep", "status"],
  ),
  receipt: objectSchema(
    {
      conversationId: { type: "string" },
      shortId: nullableString,
      name: nullableString,
      watermarkStep: { type: "integer" },
      queued: { type: "boolean" },
      reason: { enum: ["done", "blocked", "error", "message", "timeout"] },
      status: { type: "string" },
      timedOut: { type: "boolean" },
      durationMs: { type: "integer" },
    },
    ["conversationId", "shortId", "watermarkStep", "queued"],
  ),
  waitResult: objectSchema(
    {
      reason: { enum: ["done", "blocked", "error", "message", "timeout"] },
      timedOut: { type: "boolean" },
      durationMs: { type: "integer" },
      target: objectSchema(
        {
          conversationId: { type: "string" },
          shortId: nullableString,
          name: nullableString,
          status: { type: "string" },
          turn: { type: "integer" },
          stepCount: { type: "integer" },
        },
        ["conversationId", "status", "turn", "stepCount"],
      ),
      latestReplyPreview: { type: "string" },
      children: {
        type: "array",
        items: objectSchema(
          {
            conversationId: { type: "string" },
            shortId: nullableString,
            name: nullableString,
            status: { type: "string" },
          },
          ["conversationId", "status"],
        ),
      },
    },
    ["reason", "target", "durationMs"],
  ),
  getSnapshot: objectSchema(
    {
      conversationId: { type: "string" },
      shortId: nullableString,
      name: nullableString,
      title: nullableString,
      status: { enum: ["idle", "working", "done", "blocked", "error"] },
      turn: { type: "integer" },
      stepCount: { type: "integer" },
      watermarkStep: { type: "integer" },
      parentId: nullableString,
      terminated: { type: "boolean" },
      labels: { type: "object" },
      telemetry: objectSchema(
        {
          inputTokens: { type: "integer" },
          cacheReadTokens: { type: "integer" },
          outputTokens: { type: "integer" },
          stepCount: { type: "integer" },
        },
        ["inputTokens", "cacheReadTokens", "outputTokens", "stepCount"],
      ),
      artifacts: {
        type: "array",
        items: objectSchema(
          {
            name: { type: "string" },
            path: { type: "string" },
            bytes: { type: "integer" },
            modifiedAt: { type: "string" },
          },
          ["name", "path"],
        ),
      },
      latestError: { type: "string" },
    },
    ["conversationId", "status", "watermarkStep", "telemetry", "artifacts"],
  ),
  readResult: objectSchema(
    {
      conversationId: { type: "string" },
      shortId: nullableString,
      name: nullableString,
      parentId: nullableString,
      labels: { type: "object" },
      status: { enum: ["idle", "working", "done", "blocked", "error"] },
      turn: { type: "integer" },
      reply: { type: "string" },
      turns: {
        type: "array",
        items: objectSchema(
          {
            turn: { type: "integer" },
            inboundType: { enum: ["USER_INPUT", "SYSTEM_MESSAGE"] },
            reply: { type: "string" },
          },
          ["turn", "inboundType", "reply"],
        ),
      },
      artifacts: { type: "array", items: { type: "object" } },
      telemetry: { type: "object" },
    },
    ["conversationId", "status", "turn", "reply", "turns", "artifacts", "telemetry"],
  ),
  lsRow: objectSchema(
    {
      shortId: nullableString,
      name: nullableString,
      conversationId: { type: "string" },
      status: { enum: ["idle", "working", "done", "blocked", "error"] },
      turn: { type: "integer" },
      stepCount: { type: "integer" },
      title: { type: "string" },
      project: { type: "string" },
      updated: { type: "string" },
      labels: { type: "object" },
      terminated: { type: "boolean" },
    },
    ["conversationId", "status", "turn", "stepCount", "labels"],
  ),
  templateRow: objectSchema(
    {
      name: { type: "string" },
      description: { type: "string" },
      model: { type: "string" },
      profile: { type: "string" },
      cwd: { type: "string" },
    },
    ["name"],
  ),
  statusReport: objectSchema(
    {
      daemon: objectSchema(
        {
          healthy: { type: "boolean" },
          pid: { type: "integer" },
          httpPort: { type: "integer" },
          lsVersion: { type: "string" },
          hubFile: { type: "string" },
          problems: { type: "array", items: { type: "string" } },
        },
        ["healthy", "problems"],
      ),
      summaries: objectSchema(
        { readable: { type: "boolean" }, conversations: { type: "integer" } },
        ["readable", "conversations"],
      ),
      agentapi: objectSchema(
        { present: { type: "boolean" }, executable: { type: "boolean" }, path: { type: "string" } },
        ["present", "executable", "path"],
      ),
      stateDb: objectSchema(
        { present: { type: "boolean" }, path: { type: "string" }, managed: { type: "integer" } },
        ["present", "path", "managed"],
      ),
    },
    ["daemon", "summaries", "agentapi", "stateDb"],
  ),
  event: objectSchema(
    {
      type: { enum: ["created", "status", "step", "turn", "artifact", "heartbeat"] },
      conversationId: { type: "string" },
      shortId: nullableString,
      name: nullableString,
      status: { type: "string" },
      stepIndex: { type: "integer" },
      stepType: { type: "string" },
      stepStatus: { type: "string" },
      turn: { type: "integer" },
      artifact: { type: "object" },
      at: { type: "string" },
    },
    ["type", "at"],
  ),
  labels: objectSchema({}, []),
} as const;

function commandSchema(
  args: string,
  options: Array<{
    name: string;
    kind: "boolean" | "string" | "integer" | "repeat";
    enum?: string[];
    default?: string;
  }>,
  outputRef: keyof typeof TYPES,
): JsonSchema {
  return objectSchema(
    {
      args: { const: args },
      options: {
        type: "object",
        properties: Object.fromEntries(
          options.map((option) => [
            option.name,
            {
              type:
                option.kind === "integer"
                  ? "integer"
                  : option.kind === "boolean"
                    ? "boolean"
                    : "string",
              ...(option.enum === undefined ? {} : { enum: option.enum }),
              ...(option.default === undefined ? {} : { const: option.default }),
            },
          ]),
        ),
      },
      output: { $ref: `#/types/${outputRef}` },
    },
    ["args", "options", "output"],
  );
}

export const CLI_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ag-cli.local/schema.json",
  title: "ag-cli",
  description: "Interfaces and JSON payload contracts for ag-cli.",
  type: "object",
  additionalProperties: false,
  properties: {
    exitCodes: {
      type: "object",
      properties: {
        ok: { const: 0 },
        failure: { const: 1 },
        invalidUsage: { const: 2 },
        preconditionFailed: { const: 3 },
        daemonUnavailable: { const: 4 },
        timeout: { const: 124 },
      },
    },
    reasons: { type: "array", items: { enum: ["done", "blocked", "error", "message", "timeout"] } },
    types: { type: "object", properties: TYPES },
    commands: {
      type: "object",
      properties: {
        run: commandSchema(
          "[template] <prompt>",
          [
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
          "runSummary",
        ),
        send: commandSchema(
          "<c> <text>",
          [
            { name: "--if", kind: "string", enum: ["idle", "done", "working"] },
            { name: "--force", kind: "boolean" },
            { name: "--wait", kind: "boolean" },
            { name: "--timeout", kind: "integer", default: "180" },
            { name: "--title", kind: "string" },
            { name: "--no-notify", kind: "boolean" },
            { name: "--raw", kind: "boolean" },
            { name: "--json", kind: "boolean" },
          ],
          "receipt",
        ),
        wait: commandSchema(
          "[c]",
          [
            { name: "--children", kind: "string", enum: ["any", "all"] },
            { name: "--timeout", kind: "integer", default: "180" },
            { name: "--json", kind: "boolean" },
          ],
          "waitResult",
        ),
        read: commandSchema(
          "[c]",
          [
            { name: "--turns", kind: "integer", default: "1" },
            { name: "--steps", kind: "boolean" },
            { name: "--lines", kind: "integer", default: "50" },
            { name: "--full", kind: "boolean" },
            { name: "--artifact", kind: "string" },
            { name: "--json", kind: "boolean" },
          ],
          "readResult",
        ),
        get: commandSchema("[c]", [{ name: "--json", kind: "boolean" }], "getSnapshot"),
        ls: commandSchema(
          "",
          [
            { name: "--all", kind: "boolean" },
            { name: "--label", kind: "repeat" },
            { name: "--children", kind: "boolean" },
            {
              name: "--status",
              kind: "string",
              enum: ["idle", "working", "done", "blocked", "error"],
            },
            { name: "--json", kind: "boolean" },
          ],
          "lsRow",
        ),
        label: commandSchema("<c> <k=v...>", [{ name: "--json", kind: "boolean" }], "labels"),
        kill: commandSchema("<c>", [{ name: "--json", kind: "boolean" }], "receipt"),
        rm: commandSchema(
          "<c>",
          [
            { name: "--purge-brain", kind: "boolean" },
            { name: "--json", kind: "boolean" },
          ],
          "receipt",
        ),
        interrupt: commandSchema("<c>", [{ name: "--json", kind: "boolean" }], "receipt"),
        templates: commandSchema("", [{ name: "--json", kind: "boolean" }], "templateRow"),
        events: commandSchema(
          "",
          [
            { name: "--target", kind: "string" },
            { name: "--children-of", kind: "string" },
            { name: "--label", kind: "repeat" },
            { name: "--heartbeat-ms", kind: "integer", default: "15000" },
            { name: "--json", kind: "boolean" },
          ],
          "event",
        ),
        status: commandSchema("", [{ name: "--json", kind: "boolean" }], "statusReport"),
        schema: commandSchema("", [], "statusReport"),
      },
    },
  },
} as const;
