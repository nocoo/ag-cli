import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Sandbox {
  root: string;
  agCliHome: string;
  configDir: string;
  antigravityDir: string;
  agentapiBin: string;
  daemonDir: string;
  summariesDbPath: string;
  brainDir: string;
  env: Record<string, string>;
  cleanup(): void;
}

export interface HubInfo {
  pid: number;
  httpPort: number;
  httpsPort: number;
  lsVersion: string;
  csrfToken: string;
}

export interface MockLanguageServer {
  server: Server;
  port: number;
  csrfToken: string;
  requests: Array<{ method: string | undefined; url: string | undefined; csrf?: string }>;
  rpcCalls: Array<{ method: string; body: unknown; csrf?: string }>;
  close(): Promise<void>;
}

export type TranscriptStep = Record<string, unknown> & {
  step_index?: number;
  type?: string;
  status?: string;
};

const SUMMARIES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversation_summaries (
    conversation_id TEXT PRIMARY KEY,
    title TEXT,
    preview TEXT,
    step_count INTEGER NOT NULL DEFAULT 0,
    last_modified_time TEXT,
    workspace_uris TEXT,
    status TEXT NOT NULL DEFAULT 'CASCADE_RUN_STATUS_IDLE',
    project_id TEXT,
    parent_conversation_id TEXT,
    nesting_depth INTEGER NOT NULL DEFAULT 0,
    not_fully_idle INTEGER NOT NULL DEFAULT 0,
    killed INTEGER NOT NULL DEFAULT 0,
    last_user_input_step_index INTEGER
  );
`;

export function createSandbox(prefix = "ag-cli-test"): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const agCliHome = join(root, "ag-cli-home");
  const configDir = join(root, "ag-cli-config");
  const antigravityDir = join(root, "antigravity");
  const agentapiBin = join(root, "bin", "mock-agentapi");

  mkdirSync(agCliHome, { recursive: true });
  mkdirSync(join(configDir, "templates"), { recursive: true });
  mkdirSync(join(antigravityDir, "daemon"), { recursive: true });
  mkdirSync(join(antigravityDir, "brain"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });

  return {
    root,
    agCliHome,
    configDir,
    antigravityDir,
    agentapiBin,
    daemonDir: join(antigravityDir, "daemon"),
    summariesDbPath: join(antigravityDir, "conversation_summaries.db"),
    brainDir: join(antigravityDir, "brain"),
    env: {
      AG_CLI_HOME: agCliHome,
      AG_CLI_CONFIG_DIR: configDir,
      AG_CLI_ANTIGRAVITY_DIR: antigravityDir,
      AG_CLI_AGENTAPI_BIN: agentapiBin,
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function writeHubFile(sandbox: Sandbox, info: HubInfo): string {
  const path = join(sandbox.daemonDir, `hub_${info.httpPort}.json`);
  writeFileSync(path, `${JSON.stringify(info)}\n`);
  return path;
}

export interface MockRpcOptions {
  responses?: Record<string, unknown | ((body: unknown) => unknown)>;
  statusCodes?: Record<string, number>;
}

export function startMockLanguageServer(options: MockRpcOptions = {}): Promise<MockLanguageServer> {
  const requests: MockLanguageServer["requests"] = [];
  const rpcCalls: MockLanguageServer["rpcCalls"] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const rpcMethod = url.startsWith("/exa.language_server_pb.LanguageServerService/")
      ? url.slice("/exa.language_server_pb.LanguageServerService/".length)
      : null;
    requests.push({
      method: req.method,
      url,
      csrf: req.headers["x-codeium-csrf-token"] as string | undefined,
    });
    const reply = (status: number, body: unknown) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on("end", () => {
        if (rpcMethod !== null) {
          let parsed: unknown = null;
          try {
            parsed = raw.length > 0 ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          rpcCalls.push({
            method: rpcMethod,
            body: parsed,
            csrf: req.headers["x-codeium-csrf-token"] as string | undefined,
          });
        }
        let payload = body;
        const configured = rpcMethod === null ? undefined : options.responses?.[rpcMethod];
        if (typeof configured === "function") {
          payload = (configured as (body: unknown) => unknown)(raw);
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    };

    if (url === "/healthz") {
      reply(200, { status: "ok" });
      return;
    }
    if (rpcMethod !== null) {
      const configured = options.responses?.[rpcMethod];
      const body = typeof configured === "function" ? null : (configured ?? {});
      reply(options.statusCodes?.[rpcMethod] ?? 200, body);
      return;
    }
    reply(404, { error: "not_found" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        throw new Error("mock language server did not bind to a tcp port");
      }
      resolve({
        server,
        port: address.port,
        csrfToken: randomUUID(),
        requests,
        rpcCalls,
        close: () =>
          new Promise<void>((onClosed) => {
            server.close(() => onClosed());
          }),
      });
    });
  });
}

export function initSummariesDb(sandbox: Sandbox): DatabaseSync {
  const db = new DatabaseSync(sandbox.summariesDbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 3000;");
  db.exec(SUMMARIES_SCHEMA);
  return db;
}

export function conversationBrainDir(sandbox: Sandbox, conversationId: string): string {
  return join(sandbox.brainDir, conversationId);
}

export function transcriptPath(sandbox: Sandbox, conversationId: string): string {
  return join(
    conversationBrainDir(sandbox, conversationId),
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

export function readTranscript(sandbox: Sandbox, conversationId: string): TranscriptStep[] {
  const path = transcriptPath(sandbox, conversationId);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TranscriptStep);
}

export function runAgentapi(
  sandbox: Sandbox,
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(sandbox.agentapiBin, args, {
    encoding: "utf8",
    env: { ...process.env, ...sandbox.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const MOCK_AGENTAPI_SCRIPT = (antigravityDir: string): string => `#!/usr/bin/env node
"use strict";
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ANTIGRAVITY_DIR = ${JSON.stringify(antigravityDir)};
const SUMMARIES_DB = join(ANTIGRAVITY_DIR, "conversation_summaries.db");
const MODE = process.env.AG_MOCK_AGENTAPI_MODE || "done";
const DELAY_MS = Number(process.env.AG_MOCK_AGENTAPI_DELAY_MS || 0);
const SCHEMA = ${JSON.stringify(SUMMARIES_SCHEMA)};

function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function openDb() {
  const db = new DatabaseSync(SUMMARIES_DB);
  db.exec("PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  return db;
}

function transcriptPath(id) {
  return join(ANTIGRAVITY_DIR, "brain", id, ".system_generated", "logs", "transcript.jsonl");
}

function ensureConversation(id) {
  mkdirSync(join(ANTIGRAVITY_DIR, "brain", id, ".system_generated", "logs"), { recursive: true });
  const path = transcriptPath(id);
  if (!existsSync(path)) writeFileSync(path, "");
}

function lastStepIndex(id) {
  const path = transcriptPath(id);
  if (!existsSync(path)) return -1;
  const lines = readFileSync(path, "utf8").split("\\n").filter(Boolean);
  if (lines.length === 0) return -1;
  return JSON.parse(lines[lines.length - 1]).step_index;
}

function appendStep(id, index, type, status, extra) {
  const step = {
    step_index: index,
    source: type === "USER_INPUT" ? "USER" : "PLANNER",
    type: type,
    status: status,
    created_at: new Date().toISOString(),
    content: "",
    thinking: null,
    tool_calls: [],
    input_tokens: 120,
    cache_read_tokens: 0,
    output_tokens: 64,
    truncated_fields: [],
  };
  Object.assign(step, extra || {});
  appendFileSync(transcriptPath(id), JSON.stringify(step) + "\\n");
}

function saveSummary(db, id, title, stepCount, status, notFullyIdle, lastUserInputStep) {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO conversation_summaries" +
      " (conversation_id, title, preview, step_count, last_modified_time, status, not_fully_idle, killed, last_user_input_step_index)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)" +
      " ON CONFLICT(conversation_id) DO UPDATE SET" +
      " step_count = excluded.step_count, status = excluded.status, not_fully_idle = excluded.not_fully_idle," +
      " last_modified_time = excluded.last_modified_time, last_user_input_step_index = excluded.last_user_input_step_index"
  ).run(id, title || "", "", stepCount, now, status, notFullyIdle, lastUserInputStep);
}

function runTurn(db, id, title, message) {
  const inbound = lastStepIndex(id) + 1;
  appendStep(id, inbound, "USER_INPUT", "DONE", { content: message });
  sleep(DELAY_MS);

  if (MODE === "stuck") {
    appendStep(id, inbound, "USER_INPUT", "DONE", { content: message });
    saveSummary(db, id, title, inbound + 1, "CASCADE_RUN_STATUS_RUNNING", 1, inbound);
    return;
  }
  if (MODE === "error") {
    appendStep(id, inbound + 1, "GENERIC", "ERROR", { content: "mock failure" });
    saveSummary(db, id, title, inbound + 2, "CASCADE_RUN_STATUS_IDLE", 0, inbound);
    return;
  }
  if (MODE === "blocked") {
    appendStep(id, inbound + 1, "GENERIC", "WAITING", {
      tool_calls: [{ name: "ask_question", status: "WAITING", arguments: { question: "Approve the plan?" } }],
    });
    saveSummary(db, id, title, inbound + 2, "CASCADE_RUN_STATUS_RUNNING", 1, inbound);
    return;
  }

  appendStep(id, inbound + 1, "GENERIC", "DONE", {
    thinking: "planning",
    tool_calls: [{ name: "read_file", status: "DONE", arguments: { path: "package.json" } }],
  });
  sleep(DELAY_MS);
  appendStep(id, inbound + 2, "PLANNER_RESPONSE", "DONE", {
    content: "Mock reply for: " + message,
    output_tokens: 128,
  });
  saveSummary(db, id, title, inbound + 3, "CASCADE_RUN_STATUS_IDLE", 0, inbound);
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--") && i + 1 < argv.length) {
      parsed[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      parsed._.push(arg);
    }
  }
  return parsed;
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const db = openDb();

  if (command === "new-conversation") {
    const id = randomUUID();
    ensureConversation(id);
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris) VALUES (?, ?, ?)"
    ).run(
      id,
      args.title || "",
      JSON.stringify({
        ls: process.env.ANTIGRAVITY_LS_ADDRESS || null,
        csrf: process.env.ANTIGRAVITY_CSRF_TOKEN || null,
        project: process.env.ANTIGRAVITY_PROJECT_ID || null,
      })
    );
    runTurn(db, id, args.title || "", args.message || "");
    emit({ conversationId: id });
    return;
  }
  if (command === "send-message") {
    const id = args["conversation-id"];
    const row = db
      .prepare("SELECT title FROM conversation_summaries WHERE conversation_id = ?")
      .get(id);
    if (!row) {
      emit({ error: "not_found", conversationId: id });
      process.exit(1);
    }
    ensureConversation(id);
    const inbound = lastStepIndex(id) + 1;
    runTurn(db, id, row.title || "", args.message || "");
    emit({ conversationId: id, stepIndex: inbound });
    return;
  }
  if (command === "get-conversation-metadata") {
    const row = db
      .prepare("SELECT * FROM conversation_summaries WHERE conversation_id = ?")
      .get(args["conversation-id"]);
    if (!row) {
      emit({ error: "not_found" });
      process.exit(1);
    }
    emit(row);
    return;
  }
  process.stderr.write("mock-agentapi: unknown command " + String(command) + "\\n");
  process.exit(2);
}

main();
`;

export function writeMockAgentapi(sandbox: Sandbox): string {
  writeFileSync(sandbox.agentapiBin, MOCK_AGENTAPI_SCRIPT(sandbox.antigravityDir), { mode: 0o755 });
  return sandbox.agentapiBin;
}
