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

## 2026-11-14 · Round 1 review lessons (ag-cli-reviewer, 32 findings)

- **Validate before dispatching.** `run` created the Antigravity conversation before
  checking `--name`/`--label`/`--timeout`, so invalid usage still dispatched work and
  left orphan conversations. All pure validation now happens before the first
  side effect, and `--name` may no longer shadow `cN` aliases.
- **Validate ids at every boundary.** A mock `conversationId` of `../../victim` made
  `rm --purge-brain` delete outside the brain root. Uuids are now asserted at the
  agentapi response, the state store and the control commands, and every destructive
  path is checked with `realpath` containment before the registry row is removed.
- **Watermarks need delivery evidence.** Completion required only
  `maxStepIndex >= watermarkStep`; the state machine now locates the inbound step at
  or after the watermark and requires a stable reply after it, with no unfinished
  work behind it.
- **Undo state when delivery fails.** `send` and `run --reuse` updated the watermark
  before contacting the daemon and never restored it, so a failed send left a
  conversation stuck in `working`. Watermarks are now restored on failure and
  auto-registered rows are removed again.
- **Watching needs a database baseline.** The watcher only stat'ed the transcript and
  opened the summaries connection lazily, so a database-only state change was missed
  until the deadline. The watcher now primes the `data_version` baseline at start,
  watches the WAL directory, and keeps a long-lived probe connection.
- **Incremental reads must respect encoding and rewrites.** Buffer decoding now uses
  `StringDecoder`, offsets advance by bytes actually read, and inode/size/mtime
  changes reset the cursor instead of silently skipping a rewrite.
- **Signal handling needs an explicit exit.** Bun keeps the event loop alive after a
  signal listener is registered, so `ag-cli events` only terminates because the CLI
  entry exits explicitly; unit tests must never call `process.exit`.
- **The push gate must test what is pushed.** `pre-push` now checks every pushed
  revision in an isolated snapshot instead of running the gates once in the working
  tree.

## 2026-11-14 · Round 2 review lessons (ag-cli-reviewer, F1–F20 + P3-30..32)

- **Fix the call site, not just the helper.** `AgentApiClient.newConversation` gained
  `model`/`projectId` parameters, but `run.ts` never passed them; the new client-level
  test stayed green while production dispatch ignored both. Regression tests must go
  through the CLI and assert the real agentapi argv/env.
- **Watermark rollback needs ownership, not value comparison.** Two concurrent
  deliveries share the same watermark value, so value-based rollback (`WHERE
  watermark_step = ?`) let a failed delivery clobber a successful one (ABA) and delete
  an adopted row out from under labels written after another delivery succeeded.
  Deliveries now carry a monotonic `delivery_seq` ticket; rollback applies only when
  the ticket still owns the row, and label writes advance the sequence too.
- **Same-name creation must be coordinated before dispatch.** Two concurrent
  `run --name X` both passed the "name free" check and both dispatched; killing a
  conversation kept the alias so `--reuse` dispatched before failing. Names are now
  released on termination, `run --name` takes an exclusive `name_reservations` row
  before `newConversation`, and `--reuse` waits out an in-flight reservation.
- **"Resources closed" and "promise settled" are different flags.** A persistence
  failure after `cleanup()` set `finished = true`, and the fail path then declined to
  reject — a forever-pending wait. Settled/stopped are tracked separately so the
  promise always resolves or rejects.
- **HTTP responses can die mid-body.** A 200 with `content-length` and a severed
  socket left the RPC pending forever because only `data`/`end` were handled. The
  client now listens for `aborted`/`error`/`close` without `end` and enforces an
  absolute deadline that destroys both request and response.
- **A rewrite must reset the cache, not just the cursor.** Equal-size and longer
  in-place rewrites reset the byte cursor, but `currentSteps()` kept serving the stale
  cache — duplicate turns, wrong telemetry. The cursor now tracks a sha256 of the
  consumed prefix; any in-place change resets cursor and cache together.
- **Watchers must stop doing I/O after close.** `onChange` callbacks that close the
  watcher let the fallback tick reopen summary probes and rebind directory watchers.
  Every post-callback step re-checks `closed`.
- **Green gates must exercise the failing layer.** Schema tests hand-resolved
  `$ref`s instead of following JSON pointers; hook scans ran gitleaks in git mode
  against a sourceless archive and trivially passed. Tests now validate real command
  output against `$defs` and the archive scan uses `--no-git`.
