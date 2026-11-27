# ag-cli

CLI runtime wrapper around the local Antigravity installation (npm `@nocoo/ag`, bin `ag-cli` -> `dist/index.js`) letting external CLI bots and Antigravity conversations dispatch tasks, wait on events, and collect structured results.
Docs: [Index](docs/README.md) · [Architecture](docs/01-overview-and-architecture.md) · [CLI & Protocol](docs/02-cli-and-protocol.md) · [State & Storage](docs/03-state-and-storage.md) · [Workflows](docs/04-skill-and-workflows.md) · [Plan](docs/05-implementation-plan.md) · [Retrospective](Retrospective.md)

## Commands

Run from root with Bun 1.4.4 / Node 26.13.0.

```sh
bun install --frozen-lockfile
bun run typecheck        # S1 tsc --noEmit
bun run lint             # S2 biome check --error-on-warnings .
bun run test:coverage    # L1 unit coverage >= 95% on src/**/*.ts
bun run test:integration # L3 integration tests
bun run test:e2e         # L4 E2E tests
bun run build            # B1 dist/index.js + dist/skill.md + dist/ag-cli (Darwin ad-hoc signed)
bun run ci:package       # P1 npm pack + installed bin & compiled binary smoke test
```

## Invariants

- Contracts in `docs/01`–`05` are locked; update the relevant numbered doc before changing behavior.
- Published package `@nocoo/ag` ships `dist/index.js` (`bin.ag-cli`) and `dist/skill.md` (resolved relative to `import.meta.url`, verified by `bun run ci:package`).
- Use Node built-ins only for SQLite and HTTP: `node:sqlite` (`DatabaseSync`) and `node:http` (`http.request`) — zero native addons and no `fetch`, keeping Node (Vitest) and Bun identical.
- Open native databases read-only via `PRAGMA query_only = ON` ([docs/03](docs/03-state-and-storage.md) §5.3), never `{ readOnly: true }`: Bun cannot query a WAL database lacking a live writer (`-shm`).
- `conversation_summaries.db` is strictly read-only (`PRAGMA query_only = ON`); `ag-cli` writes only to its own `state.db`.
- Derive conversation state from observed facts only; never regex-guess model prose.
- Tests never touch `~/.gemini/antigravity` or `~/.local/share/ag-cli`; isolate in temp dirs via `AG_CLI_HOME`, `AG_CLI_CONFIG_DIR`, `AG_CLI_ANTIGRAVITY_DIR`, `AG_CLI_AGENTAPI_BIN` (`tests/helpers/sandbox.ts`).
- Keep `bun.lock` free of direct `https` URLs (`rg -c '", "https' bun.lock` stays empty, enforced by `pre-commit`); rewrite redirect URLs to `""` after installs ([Retrospective.md](Retrospective.md)).
- Follow strict TDD per [docs/05](docs/05-implementation-plan.md): Red -> Green -> Refactor -> Gate before committing on `main`.

## Quality & Local Gates

Follows `system1-quality`; CI runs `.github/workflows/pipeline.yml` -> [`.github/workflows/quality-slots.yml`](.github/workflows/quality-slots.yml) (`quality / Z1: Gate` required on `main`, pinned `base-ci` `v2026.24`). No automated CD workflow: releases use local `npm publish` only after verified CI. Status vocabulary: `enforced`, `planned`, `manual`, `N/A`.

- **Exceptions / boundaries**: `L2 Runtime` is `N/A` (local macOS CLI wrapper without Cloudflare Worker or platform runtime bindings); all other 11 slots are `enforced` in CI.
- **Coverage scope**: `L1 Unit` enforces >= 95% statements/branches/functions/lines on `src/**/*.ts` excluding `src/types/**` and `src/index.ts` ([vitest.config.ts](vitest.config.ts)).
- **Local hooks**: installed via `bun run prepare` (`core.hooksPath` = `scripts/hooks`); `pre-commit` verifies a staged index snapshot (`G1`, no `.only`/`.skip`, `bun.lock` URL purity, `L1`, `S1`, `S2`).
- **Pre-push gate**: checks each pushed commit OID in an isolated `git archive` snapshot (`G1`, `G2`, `B1`, `L3`, `L4`, `P1`).

## Retrospective

Record incident narratives in [Retrospective.md](Retrospective.md); promote recurring project constraints to `Invariants` above and enforceable safeguards to tests/hooks.
