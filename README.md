<h1 align="center">ag-cli</h1>
<p align="center">面向本机 Antigravity 运行环境的轻量级 CLI Wrapper，用于派发任务、监听事件并回收结构化结果。</p>
<p align="center"><a href="docs/README.en.md">English</a></p>

## 这是什么

`ag-cli`（npm 包 `@nocoo/ag`）是运行在本机 Antigravity 安装环境之上的命令行包装器，让外部 CLI Agent（如 `pi`、Claude Code、Codex）以及内部 Antigravity 会话能够通过统一命令与结构化 JSON 协议创建或复用会话、发送消息、事件驱动等待并读取回复与产物。

工具仅读取 Antigravity 的 `conversation_summaries.db`（以 `PRAGMA query_only = ON` 只读方式打开），所有自身状态与标签均写入独立的 `state.db`。仅支持本机已安装并运行 Antigravity 的环境（目前主要面向 macOS）。

## 功能

- **会话管理**：`run`（支持 `--bg` 后台派发、`--name` 与 `--reuse` 复用）、`ls`、`get`、`read`、`kill`、`rm`、`label`。
- **对话与等待**：`send`（支持 `--wait`）、`interrupt`、`wait`（支持 `--children any|all` 等待子会话）。
- **可观测性与协议**：`events` 实时事件流（管道输出为 NDJSON）、`templates` 模板列表、`status` 运行环境体检、`schema` 输出 CLI/API JSON Schema，以及 `ag-cli --skill` 内置操作手册。
- **自适应输出**：TTY 终端输出人类可读摘要；管道输出默认切换为 JSON（`run` 与 `read` 除外），显式传入 `--json` 时始终输出 JSON。
- **确定性状态推导**：基于本地数据库与 transcript 观测事实推导五态，不对模型文本做正则猜测。

## 使用

安装或构建后可直接通过 `ag-cli` 调用：

```sh
ag-cli --help
ag-cli status
ag-cli run --name demo "检查当前仓库状态"
ag-cli run --bg --name worker "运行测试并汇总结果"
ag-cli wait worker
ag-cli read worker
ag-cli ls
```

目标 `<c>` 支持精确别名（`name`）、短 ID（如 `c7`）、唯一 UUID 前缀或完整 36 位 UUID；在 Antigravity 会话内执行时，`get`、`read` 与 `wait --children` 可自动关联当前会话。

## 开发

开发环境需要 Bun `1.4.4` 与 Node.js `26.13.0`（或兼容版本）。

```sh
bun install --frozen-lockfile
bun run prepare          # 安装 scripts/hooks 本地 Git hooks
bun run typecheck        # tsc --noEmit
bun run lint             # biome check --error-on-warnings .
bun run build            # 构建 dist/index.js、dist/skill.md 与 dist/ag-cli
bun run ci:package       # 验证 npm pack 与产物可执行性
```

核心实现仅使用 Node 内置的 `node:sqlite`（`DatabaseSync`）与 `node:http`（`http.request`），避免原生依赖与运行时差异。

## 测试

测试通过 `AG_CLI_HOME`、`AG_CLI_CONFIG_DIR`、`AG_CLI_ANTIGRAVITY_DIR` 与 `AG_CLI_AGENTAPI_BIN` 隔离在临时沙箱目录中，不会触碰本机真实 Antigravity 数据。

```sh
bun run test                 # 运行全部 Vitest 测试
bun run test:coverage        # 单元测试覆盖率（src/**/*.ts 要求 >= 95%）
bun run test:integration     # 集成测试
bun run test:e2e             # 端到端测试
```

## 技术栈

- **运行时与语言**：TypeScript、Bun、Node.js（`node:sqlite`、`node:http`）
- **依赖与配置解析**：`yaml`
- **构建与打包**：`bun build`（Node CLI `dist/index.js` 与单文件二进制 `dist/ag-cli`）
- **代码质量与测试**：Biome、Vitest（`@vitest/coverage-v8`）

## 文档

- [文档索引](docs/README.md)
- [01 · 项目概述与系统架构](docs/01-overview-and-architecture.md)
- [02 · CLI 接口与交互协议](docs/02-cli-and-protocol.md)
- [03 · 状态机、水位线与本地存储](docs/03-state-and-storage.md)
- [04 · 内置 Skill 与协同工作流](docs/04-skill-and-workflows.md)
- [05 · 工程结构、质量体系与实施计划](docs/05-implementation-plan.md)
- [项目契约](AGENTS.md) · [复盘记录](Retrospective.md)

## 许可证

[MIT](LICENSE)
