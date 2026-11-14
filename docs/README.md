# `ag-cli` · 文档索引

> 遵循 `dev-standard-numbered-docs` 编号文档规范：文件名采用 `NN-title.md`，编号严格递增排序；`docs/README.md` 为所有架构与设计子文档的唯一入口。

**`ag-cli`** 是面向本机 Antigravity 运行环境的轻量级 CLI Runtime Wrapper，协议设计与代理编排心智全面对齐 [`herdr-core` (`hc`)](file:///Users/nocoo/workspace/references/herdr-core/README.md)，让任意外部 CLI Bot（如 `pi`、Claude Code、Codex）与内部 Antigravity 会话都能够以标准命令行和结构化 JSON 协议向本机 Antigravity 派发任务、双向通信、事件驱动等待并回收结果与产物。

---

## 顶层文档

| 编号 | 主题 | 状态 | 核心内容摘要 |
| --- | --- | --- | --- |
| [01](./01-overview-and-architecture.md) | 项目概述与系统架构 | `v0.3-locked`（2026-11-14） | 核心痛点、`hc` ↔ `ag-cli` 概念映射、Antigravity 本机运行机制、分层架构图与技术栈 ADR（锁定 TypeScript + Bun） |
| [02](./02-cli-and-protocol.md) | CLI 接口与交互协议 | `v0.3-locked`（2026-11-14） | 完整 `ag-cli` 命令集、NPM 包名与命令（`ag-cli`）决议、寻址体系 `<c>`、TTY/JSON 输出契约与信封协议 |
| [03](./03-state-and-storage.md) | 状态机、水位线与本地存储 | `v0.3-locked`（2026-11-14） | Observed Facts 五态推导真值表、Turn Watermark 防竞态算法、FSWatcher 引擎与 `state.db` Schema |
| [04](./04-skill-and-workflows.md) | 内置 Skill 与协同工作流 | `v0.3-locked`（2026-11-14） | `ag-cli --skill` 内置手册全文草案、外部 Bot 派活 / 主控编排 / `hc`+`ag-cli` 双向协同三大流 |
| [05](./05-implementation-plan.md) | 工程结构、质量体系与实施计划 | `v0.3-locked`（2026-11-14） | 模块划分、System0 12 槽位质量体系（对齐 `base-ci` v2026.15）、`AG_CLI_HOME` 沙箱隔离、严格 TDD/DDD 流程与主分支原子提交规划 |

---

## 目录约定

| 目录 | 用途 |
| --- | --- |
| `docs/*.md` | 顶层编号设计与架构文档（当前为 `v0.1-plan` Review 基线） |
| `docs/archive/` | 后续演进中被取代或废弃的历史设计文档 |
