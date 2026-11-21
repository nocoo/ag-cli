<h1 align="center">ag-cli</h1>
<p align="center">Lightweight CLI wrapper around local Antigravity conversations to dispatch tasks, wait on events, and collect structured results.</p>
<p align="center"><a href="../README.md">简体中文</a></p>

## What It Does

`ag-cli` (npm package `@nocoo/ag`) wraps the local Antigravity installation so external CLI agents (such as `pi`, Claude Code, and Codex) and internal Antigravity conversations can start or reuse conversations, send messages, wait on events, and retrieve replies and artifacts through a consistent CLI and JSON protocol.

It reads Antigravity's `conversation_summaries.db` strictly in read-only mode (`PRAGMA query_only = ON`) and writes its own state and labels exclusively to `state.db`. It targets local environments with Antigravity installed and running (currently macOS).

## Features

- **Conversation lifecycle**: `run` (with `--bg`, `--name`, `--reuse`, and `--project`), `ls`, `get`, `read`, `kill`, `rm`, and `label`.
- **Messaging & waiting**: `send` (with `--wait`), `interrupt`, and `wait` (supporting `--children any|all`).
- **Observability & protocol**: `events` live stream (NDJSON when piped), `projects` registered project list, `templates`, `status` health check, `schema` CLI/API JSON Schema output, and built-in `ag-cli --skill` instructions.
- **Adaptive output**: human-readable summaries on TTY; automatic JSON when piped (except `run` and `read`), or always JSON with `--json`.
- **Deterministic state**: derives five conversation states from observed database and transcript facts without regex-guessing model prose.

## Usage

Install globally and invoke `ag-cli` directly:

```sh
npm install -g @nocoo/ag
ag-cli --help
ag-cli status
ag-cli projects
ag-cli run --name demo "Inspect current repository status"
ag-cli run --bg --name worker --project <id|name> "Run tests and summarize results"
ag-cli wait worker
ag-cli read worker
ag-cli ls
```

Target `<c>` accepts an exact `name`, short ID (such as `c7`), unique UUID prefix, or full 36-character UUID. Inside an Antigravity conversation, `get`, `read`, and `wait --children` default to the current conversation.

## Development

Development requires Bun `1.4.4` and Node.js `26.13.0` (or compatible versions).

```sh
bun install --frozen-lockfile
bun run prepare          # install local Git hooks from scripts/hooks
bun run typecheck        # tsc --noEmit
bun run lint             # biome check --error-on-warnings .
bun run build            # build dist/index.js, dist/skill.md, and dist/ag-cli
bun run ci:package       # verify npm pack and binary smoke tests
```

Core code uses Node built-ins `node:sqlite` (`DatabaseSync`) and `node:http` (`http.request`) with zero native addons.

## Tests

Tests run in isolated temp directories using `AG_CLI_HOME`, `AG_CLI_CONFIG_DIR`, `AG_CLI_ANTIGRAVITY_DIR`, and `AG_CLI_AGENTAPI_BIN` without touching real local Antigravity data.

```sh
bun run test                 # run all Vitest projects
bun run test:coverage        # unit coverage (>= 95% on src/**/*.ts)
bun run test:integration     # integration tests
bun run test:e2e             # end-to-end tests
```

## Stack

- **Runtime & language**: TypeScript, Bun, Node.js (`node:sqlite`, `node:http`)
- **Dependencies**: `yaml`
- **Build & packaging**: `bun build` (Node CLI `dist/index.js` and standalone binary `dist/ag-cli`)
- **Quality & testing**: Biome, Vitest (`@vitest/coverage-v8`)

## Documentation

- [Documentation Index](README.md)
- [01 · Overview and Architecture](01-overview-and-architecture.md)
- [02 · CLI and Protocol](02-cli-and-protocol.md)
- [03 · State and Storage](03-state-and-storage.md)
- [04 · Skill and Workflows](04-skill-and-workflows.md)
- [05 · Implementation Plan](05-implementation-plan.md)
- [Project Contract](../AGENTS.md) · [Retrospective](../Retrospective.md)

## License

[MIT](../LICENSE)
