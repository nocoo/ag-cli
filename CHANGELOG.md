# Changelog

All notable changes to `@nocoo/ag` (`ag-cli`) are documented in this file.

## [0.2.0] - 2026-11-22

### Added
- `ag-cli projects` read-only command to list registered Antigravity projects (`id`, `name`, `folderUris`) in TTY table or JSON output (`--json` / piped).
- `ag-cli run --project <id|name>` option and template frontmatter `project` field to explicitly target a specific Antigravity project.

### Changed
- Aligned `ListProjects`, `ReadProject` (`{ id }`), and `CancelCascadeInvocation` (`{ cascadeId }`) RPC payloads with Antigravity `2.34.0`.
- Added `--` argument separator before positional prompt/message arguments in `agentapi new-conversation` and `agentapi send-message` so leading `-` strings are parsed safely.
- Unwrapped `response.conversationMetadata` in `getConversationMetadata`.
- Added strict ambiguity detection (`ambiguous_target`, exit code `1`) listing candidate project names and IDs when multiple projects share a `--cwd` folder and `--project` is omitted.
- Cleared unbound inherited `ANTIGRAVITY_PROJECT_ID` from child `agentapi` environments while keeping `ANTIGRAVITY_SOURCE_METADATA` intact, and fell back to ambient `ANTIGRAVITY_PROJECT_ID` only when neither `--project` nor `--cwd` is specified.
- Updated `README.md`, `docs/README.en.md`, `AGENTS.md`, `docs/01-overview-and-architecture.md`, and `docs/02-cli-and-protocol.md`.

## [0.1.1] - 2026-11-17

### Fixed
- Aligned `agentapi` CLI invocations (`new-conversation`, `send-message`, `get-conversation-metadata`) to positional arguments and unwrapped nested `response.*` payloads.
- Added Darwin ad-hoc signing (`codesign -s - -f dist/ag-cli`) to the compiled binary build script.
- Migrated CI quality slots to `base-ci` `v2026.15` native mode.

## [0.1.0] - 2026-11-14

### Added
- Initial release of `@nocoo/ag` (`ag-cli`): `run` (`--bg`, `--name`, `--reuse`), `send` (`--wait`, `--if`, `--force`), `wait` (`--children any|all`), `events`, `ls`, `get`, `read` (`--steps`), `label`, `interrupt`, `kill`, `rm` (`--purge-brain`), `templates`, `status`/`doctor`, `schema`, and `--skill`.
