# Retrospective

## 2026-11-14 · spawnSync blocks the in-process mock server (Phase 1.4 e2e)

**Symptom**: e2e `status --json` against the built CLI reported `daemon: healthy: false`
("unreachable /healthz") while unit tests of the same code path passed. The failing test
took exactly ~1.5s (the probe timeout).

**Root cause**: `spawnSync` blocks the vitest event loop. The mock `language_server`
running in the same vitest process could never `accept()` the subprocess's HTTP
connection, so the CLI child's `/healthz` fetch always timed out. Same-process unit
tests never hit this because the fetch and the server shared one live event loop.

**Prevention**: when a test hosts an in-process `node:http` mock, never probe it from a
child spawned with `spawnSync`/`execFileSync` from that same process. Use async
`execFile` (promisified) so the event loop keeps serving, or host the mock server in a
separate process. Rule applied in `tests/e2e/readonly.test.ts`.

## 2026-11-14 · `for...of` cannot skip consumed flag values (Phase 1.4)

Rewrote `parseCommandFlags` as `for...of` with a manual index and kept `index += 1` to
skip a consumed `--flag value` pair — but `for...of` iterates every element regardless,
so the value leaked into positionals. Tests caught it immediately (value "3" appeared in
positionals). Fix: a `skipNext` boolean. Prevention: index-mutation skip logic only works
with real `for (let i ...)` loops; with `for...of` use an explicit skip flag.

## 2026-11-14 · bun 1.4.4 bakes mirror redirect URLs into bun.lock (Phase 0)

`BUN_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/` redirects tarball
downloads to `ms-feed-25.pkgs.visualstudio.com`, and bun records the final URL in
`bun.lock` (106 entries), failing the purity gate and breaking CI installs on public
runners. Fix: after every `bun install`/`bun add`, rewrite the resolved URLs to `""`
(empty = derive from the default registry; local mirror installs still resolve via
`BUN_CONFIG_REGISTRY`, verified with cold-cache frozen installs):

```sh
python3 -c "import re; s=open('bun.lock').read(); open('bun.lock','w').write(re.sub(r'\"https://[^\"]*\", \{', '\"\", {', s))"
```

`scripts/hooks/pre-commit` enforces the invariant (`rg -c '", "https' bun.lock` empty).

## 2026-11-14 · `return promise` inside try/finally closes resources early (Phase 2.3)

**Symptom**: sync `run` (no `--bg`) hung forever; the wait engine's interval tick then
crashed with `database is not open` because the reader was closed while the wait promise
was still pending.

**Root cause**: `try { return finishRun(...); } finally { reader.close(); }` — without
`return await`, the async function returns the pending promise and the `finally` block
runs immediately, closing the reader/store the promise still uses.

**Prevention**: when a try block returns a promise that still consumes try-scoped
resources, always `return await`. Rule applied in `src/cli/commands/run.ts`.

## 2026-11-14 · Bun vs Node sqlite `readOnly` divergence on WAL databases (Phase 2.3)

Bun's `new DatabaseSync(path, { readOnly: true })` opens fine but fails queries with
`unable to open database file` when a WAL database has no live writer (no `-shm` file).
Node's vitest runtime tolerated the same state, so tests passed while the bun runtime
broke. Fix: `SummariesReader` now opens normally and enforces read-only with
`PRAGMA query_only = ON` (engine-level, identical behavior on both runtimes).

## 2026-11-14 · `run --name` conflicts must be checked before dispatch (Phase 2.3)

Registering the name in `state.db` after `newConversation` meant a `name_conflict`
throw left a freshly created Antigravity conversation unmanaged (orphan) that leaked
into `ls`. Fix: `run.ts` pre-checks name availability before contacting the daemon.

## 2026-11-14 · FSEvents can be silent under load — the fallback timer is the contract (Phase 3.1)

`fs.watch` on macOS (FSEvents) occasionally delivers no event for seconds while the
vitest worker is saturated, which made watcher tests flaky. Fixes: tests that only
assert "the change is noticed" must enable the stat-based fallback timer (the same
mechanism docs/03 §4.3 prescribes), and debounce assertions must tolerate a merged
batch instead of demanding exactly one callback. The watcher keeps both paths: the
20ms debounce for latency, the fallback for correctness.

## 2026-11-14 · `PRAGMA data_version` is only visible on a long-lived connection (Phase 3.1)

Opening a fresh `DatabaseSync` for every fallback check always reports the same
`data_version`, so summaries-change detection never fired. The watcher now keeps one
query-only probe connection open and polls `PRAGMA data_version` on it — the pattern
the SQLite docs describe.

## 2026-11-14 · Incremental readers must pick one offset strategy (Phase 3.1)

Mixing "offset points at the last complete line" with "prepend the buffered partial
line" duplicated the partial bytes and corrupted every completed line. The watcher
now advances the offset to the file size and keeps the partial line as a string
buffer, so chunks are never re-read.

## 2026-11-14 · `--skill` must not depend on the process cwd (Phase 4.1)

`ag-cli --skill` reads `skill.md` relative to `import.meta.url`, and the build copies
the file next to `dist/index.js`. The manual therefore works from any directory and
inside the packed tarball; `scripts/check-package.ts` smoke-tests it after install.
