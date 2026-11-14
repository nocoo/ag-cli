export const SKILL_MANUAL = `# nullg manual

\`nullg\` lets coding agents and terminal bots start, reuse, message, wait on,
and read results from local Antigravity conversations.
\`<c>\` below means a name (\`deps-clip\`), short ID (\`c7\`), UUID prefix, or full UUID.
Piped output is JSON except \`run\` (summary) and \`read\` (Markdown reply).
Use \`nullg <command> --help\` for exact arguments; \`nullg --help\` lists commands.

## Delegate a task

First check \`nullg templates\`: ready-made roles may include \`browser-verifier\` or
\`researcher\`. Use one that fits, or start a conversation directly:

\`\`\`sh
nullg run --bg --name ui-check --cwd /path/to/repo browser-verifier "Verify login flow on http://localhost:3000"
\`\`\`

- Prefer \`--bg\` when running multiple tasks or delegating from another agent so
  your shell tool does not block while waiting.
- Use \`--reuse --name <name>\` for persistent per-repo workers: if a live
  conversation with that name exists, \`nullg\` reuses its context via \`send-message\`;
  otherwise it creates a new one.
- Give each worker a unique \`--name\` and \`--label task=<slug>\`.

## Talk, wait, and collect results

\`\`\`sh
nullg ls                              # active nullg-managed conversations (--all: everything)
nullg get ui-check                    # observed state, status, turn, tokens, artifacts
nullg wait ui-check --timeout 300     # event-driven wait (never sleep or poll)
nullg read ui-check                   # latest reply and artifact paths
nullg read ui-check --steps --lines 30 # inspect thinking/tool trace
nullg send --wait ui-check "Now check dark mode too"
nullg interrupt ui-check              # cancel current turn, keep context
\`\`\`

Wait outcomes (\`reason\` in JSON):
- \`done\`: turn finished past the delivery watermark; run \`nullg read <c>\`.
- \`blocked\`: conversation is waiting for approval or answered \`ask_question\`;
  inspect with \`nullg read <c> --steps\` before deciding (\`send\` requires \`--force\`).
- \`error\`: execution errored or terminated.
- \`timeout\` (exit code 124): check-in; worker is still running, call \`nullg wait\` again.
- \`message\`: with \`nullg wait --children any\`, caller received an incoming message.

## Wait for multiple workers

\`\`\`sh
nullg wait --children any             # return when any child updates or you get a message
nullg wait --children all             # return when no child is working
\`\`\`

## Follow work live

\`\`\`sh
nullg events --target ui-check        # NDJSON state/step/terminal events + heartbeats when piped
\`\`\`

## Reporting back (\`<nullg>\` envelope)

If your prompt arrives wrapped in:

\`\`\`text
<nullg from="hc:t7" reach="hc send t7 when done or blocked">...</nullg>
\`\`\`

Execute the exact \`reach\` command with a concise summary and artifact paths
when you finish or get blocked.

## Cleanup

\`\`\`sh
nullg kill <c> && nullg rm <c>       # mark terminated and unregister alias
\`\`\`

\`nullg rm\` never deletes Antigravity's underlying \`/brain/\` artifacts unless \`--purge-brain\` is passed.`;

export function skillManual(): string {
  return SKILL_MANUAL;
}
