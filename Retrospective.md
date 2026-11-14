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
