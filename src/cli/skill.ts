export const SKILL_MANUAL = `# ag-cli manual

\`ag-cli\` lets coding agents and terminal bots start, reuse, message, wait on,
and read results from local Antigravity conversations.
\`<c>\` below means a name (\`deps-clip\`), short ID (\`c7\`), UUID prefix, or full UUID.
Piped output is JSON except \`run\` (summary) and \`read\` (Markdown reply).
Use \`ag-cli <command> --help\` for exact arguments; \`ag-cli --help\` lists commands.

## Delegate a task

First check \`ag-cli templates\`: ready-made roles may include \`browser-verifier\` or
\`researcher\`. Use one that fits, or start a conversation directly:

\`\`\`sh
ag-cli run --bg --name ui-check --cwd /path/to/repo browser-verifier "Verify login flow on http://localhost:3000"
\`\`\`

- Prefer \`--bg\` when running multiple tasks or delegating from another agent so
  your shell tool does not block while waiting.
- Use \`--reuse --name <name>\` for persistent per-repo workers: if a live
  conversation with that name exists, \`ag-cli\` reuses its context via \`send-message\`;
  otherwise it creates a new one.
- Give each worker a unique \`--name\` and \`--label task=<slug>\`.

## Talk, wait, and collect results

\`\`\`sh
ag-cli ls                              # active ag-cli-managed conversations (--all: everything)
ag-cli get ui-check                    # observed state, status, turn, tokens, artifacts
ag-cli wait ui-check --timeout 300     # event-driven wait (never sleep or poll)
ag-cli read ui-check                   # latest reply and artifact paths
ag-cli read ui-check --steps --lines 30 # inspect thinking/tool trace
ag-cli send --wait ui-check "Now check dark mode too"
ag-cli interrupt ui-check              # cancel current turn, keep context
\`\`\`

Wait outcomes (\`reason\` in JSON):
- \`done\`: turn finished past the delivery watermark; run \`ag-cli read <c>\`.
- \`blocked\`: conversation is waiting for approval or answered \`ask_question\`;
  inspect with \`ag-cli read <c> --steps\` before deciding (\`send\` requires \`--force\`).
- \`error\`: execution errored or terminated.
- \`timeout\` (exit code 124): check-in; worker is still running, call \`ag-cli wait\` again.
- \`message\`: with \`ag-cli wait --children any\`, caller received an incoming message.

## Wait for multiple workers

\`\`\`sh
ag-cli wait --children any             # return when any child updates or you get a message
ag-cli wait --children all             # return when no child is working
\`\`\`

## Follow work live

\`\`\`sh
ag-cli events --target ui-check        # NDJSON state/step/terminal events + heartbeats when piped
\`\`\`

## Reporting back (\`<ag-cli>\` envelope)

If your prompt arrives wrapped in:

\`\`\`text
<ag-cli from="hc:t7" reach="hc send t7 when done or blocked">...</ag-cli>
\`\`\`

Execute the exact \`reach\` command with a concise summary and artifact paths
when you finish or get blocked.

## Cleanup

\`\`\`sh
ag-cli kill <c> && ag-cli rm <c>       # mark terminated and unregister alias
\`\`\`

\`ag-cli rm\` never deletes Antigravity's underlying \`/brain/\` artifacts unless \`--purge-brain\` is passed.`;

export function skillManual(): string {
  return SKILL_MANUAL;
}
