# AGENTS.md

`ag-cli` is a CLI runtime wrapper around the local
Antigravity installation: external CLI bots and Antigravity conversations
dispatch tasks, wait on events, and collect structured results.

## Sources of truth

| Fact           | Where                                                        |
| -------------- | ------------------------------------------------------------ |
| Contracts      | `docs/01`–`05` (locked); update docs before changing behavior |
| Accidents      | `Retrospective.md`                                           |
| Package        | npm `ag-cli`, bin `ag-cli` -> `./dist/index.js`              |

## Commands

```sh
BUN_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ bun install
bun run typecheck        # S1 tsc --noEmit
bun run lint             # S2 biome check --error-on-warnings .
bun run test:coverage    # L1 unit coverage >= 95% (statements/branches/functions/lines)
bun run test:integration # L3
bun run test:e2e         # L4
bun run build            # B1 dist/index.js + dist/skill.md + dist/ag-cli (compiled binary)
bun run ci:package       # P1 npm pack + bin smoke test
```

Never hit `registry.npmjs.org`; the mirror is the only registry. `bun.lock`
must keep zero direct upstream URLs: `rg -c '", "https' bun.lock` stays empty.

## Hard rules

- SQLite and HTTP only via built-ins: `node:sqlite` (`DatabaseSync`) and
  `node:http` (`http.request`). Zero native addons and no `fetch`, so Node
  (vitest) and Bun behave identically.
- Native databases are opened read-only through `PRAGMA query_only = ON`
  (engine-level write rejection, matching `docs/03` §5.3). File-level
  `readOnly: true` is not used: Bun cannot query a WAL database that has no
  live writer and therefore no `-shm` file.
- Tests never touch real `~/.gemini/antigravity` or `~/.local/share/ag-cli`.
  Always isolate via `AG_CLI_HOME`, `AG_CLI_CONFIG_DIR`,
  `AG_CLI_ANTIGRAVITY_DIR`, `AG_CLI_AGENTAPI_BIN` into temp dirs
  (`tests/helpers/sandbox.ts`).
- `conversation_summaries.db` is strictly read-only (`PRAGMA query_only = ON`);
  ag-cli writes only its own `state.db`.
- State derives from observed facts only; never regex-guess model prose.
- Strict TDD per `docs/05`: Red -> Green -> Refactor -> Gate, then an atomic
  commit on `main` (Conventional Commits, <= 50 chars, explicit `git add`).
- Git hooks live in `scripts/hooks` (`git config core.hooksPath scripts/hooks`,
  set by `prepare`). Never push unprompted.

## Quality slots (base-ci v2026.15)

S1 Types, S2 Lint, S3 Workflow, G1 Secrets, G2 Dependencies, B1 Build, L1 Unit
(>= 95%), L3 Integration, L4 E2E, P1 Package, Z1 Gate are `impl`. L2 Runtime is
`na`: local macOS CLI wrapper without Cloudflare Worker or platform runtime
bindings. CI is `.github/workflows/ci.yml` calling
`nocoo/base-ci/.github/workflows/quality.yml@777bbe4f9bacab8a91d8c01974480a6ee23d28e0`.
