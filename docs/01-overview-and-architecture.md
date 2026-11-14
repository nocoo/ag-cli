# 01 · 项目概述与系统架构

> 状态：`v0.3-locked`（2026-11-14 · 已锁定技术栈、包名 `ag-cli` 与架构）
> 索引：[docs/README.md](./README.md)
> 相关文档：[02-cli-and-protocol.md](./02-cli-and-protocol.md) · [03-state-and-storage.md](./03-state-and-storage.md) · [04-skill-and-workflows.md](./04-skill-and-workflows.md) · [05-implementation-plan.md](./05-implementation-plan.md)

---

## 1. 一句话定义与项目定位

**`ag-cli`** 是本机 Antigravity 的轻量级 **CLI Runtime Wrapper**（对标 [`herdr-core` (`hc`)](file:///Users/nocoo/workspace/references/herdr-core/README.md)）。

`hc` 让编码代理在持久终端中启动、管理、交互并回收其他 CLI 程序；`ag-cli` 则在同样的交互哲学与协议风格下，让任意外部或内部 Agent（`pi`、Claude Code、Codex、Antigravity 主控会话、本地自动化脚本）能够通过标准命令行向本机 Antigravity **分派任务（Conversation）、注入指令、事件驱动等待、提取结构化结果与产物**。

**核心边界**：
- `ag-cli` 是无头运行时包装层，不渲染任何 GUI 界面。
- `ag-cli` 绝不猜测内部推理内容或用脆弱正则匹配输出文本猜测状态，所有状态严格来自可观测事实（Observed Facts Only）。
- `ag-cli` 作为本机客户端直接复用 Antigravity 官方 `language_server` / `agentapi` IPC 通道与本地落盘数据结构，不修改或侵入 Antigravity 安装包本身。

---

## 2. 本机运行事实与现有痛点

通过实测本机 Antigravity 运行环境（`/Applications/Antigravity.app` 与 `~/.gemini/antigravity/`），已确认以下底层运行事实与集成痛点：

### 2.1 Antigravity 本机运行机制

| 组件 / 路径 | 职责与数据结构 |
| --- | --- |
| **守护进程发现文件**<br>`~/.gemini/antigravity/daemon/hub_<port>.json` | `language_server` 监听本地 HTTP/HTTPS 服务后写入的 JSON 凭证文件，包含 `pid`、`httpPort`、`httpsPort`、`lsVersion`、`csrfToken`。 |
| **官方 IPC CLI**<br>`~/.gemini/antigravity/bin/agentapi` | 封装 `language_server agentapi "$@"`，提供 `new-conversation`、`send-message`、`get-conversation-metadata` 三个子命令；支持 `ANTIGRAVITY_PROJECT_ID` 指定归属项目。 |
| **会话索引数据库**<br>`~/.gemini/antigravity/conversation_summaries.db` | SQLite WAL 模式。`conversation_summaries` 表包含 `conversation_id`、`title`、`preview`、`step_count`、`last_modified_time`、`workspace_uris`、`status`（`CASCADE_RUN_STATUS_IDLE` / `CASCADE_RUN_STATUS_RUNNING`）、`project_id`、`parent_conversation_id`、`nesting_depth`、`not_fully_idle`、`killed`、`last_user_input_step_index` 等字段。 |
| **实时会话轨迹流**<br>`~/.gemini/antigravity/brain/<conv_id>/.system_generated/logs/transcript.jsonl` | 每行一个 JSON step，含 `step_index`、`source`、`type`（`USER_INPUT` / `SYSTEM_MESSAGE` / `PLANNER_RESPONSE` / `GENERIC`）、`status`（`RUNNING` / `DONE` / `ERROR` / `WAITING`）、`created_at`、`content`、`thinking`、`tool_calls`、`input_tokens`、`cache_read_tokens`、`output_tokens`、`truncated_fields`。另有未截断版本 `transcript_full.jsonl`。 |
| **会话产物目录**<br>`~/.gemini/antigravity/brain/<conv_id>/` | 存放会话产出的 Markdown Artifacts、截图、临时脚本等文件。 |

### 2.2 外部 Bot 与编排脚本面临的核心痛点

1. **外部终端调用直接失败**：在外部终端（`hc` 终端、`pi`、Claude Code、Codex、普通 Shell）中未注入 `ANTIGRAVITY_LS_ADDRESS` 与 `ANTIGRAVITY_CSRF_TOKEN`，直接执行 `agentapi` 会直接报错退出：`{"error": "ANTIGRAVITY_LS_ADDRESS is not set"}`。
2. **原生原语过于薄弱**：`agentapi` 仅有创建、发信、查元数据三个孤立命令，缺少 `ls`（列出活跃会话）、`wait`（异步事件等待）、`read`（提取回复与 Artifacts）、`label`（按任务标签隔离）、`templates`（角色模板）等编排能力。
3. **UUID 寻址极不友好**：所有会话均为 36 位 UUID（如 `990014f6-f6d1-4567-adcf-6182cead394c`），无短 ID 或唯一名称路由；现有编排技能（如 `deps-fix-orchestrator`）被迫手写 30+ 行 `sqlite3` SQL、轮询 `schedule` 定时器以及 Python 脚本手工解析 `transcript.jsonl`。
4. **存在投递竞态（Delivery Race）**：调用 `agentapi send-message` 成功返回的瞬间，接收端状态在短时间内仍可能停留在 `CASCADE_RUN_STATUS_IDLE`，直接检查状态极易误判为"已完成"。

---

## 3. 与 `herdr-core` (`hc`) 的核心概念映射

`ag-cli` 在命令设计、参数语义、输出风格、状态抽象与父子协同上全面对齐 `hc`：

| 维度 | `herdr-core` (`hc`) | `ag-cli` | 设计对齐说明 |
| --- | --- | --- | --- |
| **托管执行单元** | Terminal（持久化 PTY） | Conversation（Antigravity 会话） | 对外部调用者均为可复用、可中途插话、有独立上下文的 Worker 实例 |
| **寻址标识 `<t>` / `<c>`** | `t7`、唯一名称 `review` | `c7`、唯一名称 `clip-worker`、UUID 前缀或完整 UUID | 屏蔽 36 位 UUID 记忆负担，优先使用易读名称与短序号 |
| **当前自身标识** | `$HC_TERMINAL_ID` | `$ANTIGRAVITY_CONVERSATION_ID`（及 `$AG_CLI_CALLER_ID`） | 运行在 Antigravity 内部时自动识别自身为 parent/caller |
| **状态机模型** | OSC 7501 协议报告五态：<br>`idle` / `working` / `done` / `blocked` / `error` | `conversation_summaries.status` + `transcript.jsonl` 尾部 step + 水位线联合推导五态 | 统一五态语义，外部编排器可用完全相同的分支逻辑处理返回结果 |
| **读取输出** | `hc read <t>`（屏幕缓冲与历史） | `ag-cli read <c>`（默认返回最新 `PLANNER_RESPONSE` 正文与 Artifacts；`--steps` 看过程） | 按会话结构分离"最终答案"、"思考/工具调用"与"产物" |
| **同步 / 异步派活** | `hc run`（等待完成） / `hc run --bg`（立即返回） | `ag-cli run`（同步等待首轮完成） / `ag-cli run --bg`（后台返回） | 支持 `--reuse` 幂等复用同名活跃会话，适应长周期 Per-Repo Worker 模式 |
| **事件驱动等待** | `hc wait <t>` / `hc wait --children any\|all` | `ag-cli wait <c>` / `ag-cli wait --children any\|all` | 基于 `fs.watch` 监听磁盘增量事件，零轮询、零空转消耗 |
| **回调信封协议** | `<hc from="t7 review" reach="hc send t7 ...">` | `<ag-cli from="c3 orch" reach="ag-cli send c3 ...">` 或跨界 `reach="hc send t7 ..."` | 同时支持同构回调（Antigravity ↔ Antigravity）与异构跨界回调（`hc` ↔ `ag-cli`） |
| **Agent 自学手册** | `hc --skill` | `ag-cli --skill` | 一条命令输出精炼操作指南，供任意接入 Agent 零样本读取使用 |
| **输出格式契约** | TTY 下人类可读文本；管道或 `--json` 下 JSON（`run`/`read` 默认文本） | 同左：TTY 友好表格/正文；Piped 或 `--json` 输出结构化 JSON（`read` 默认 Markdown 正文） | 既方便人类终端直看，也天然适配 jq 与程序解析 |

---

## 4. 系统分层架构

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                              调用方 (Callers)                                │
│   pi / Claude Code / Codex (in hc)  │  Antigravity Orchestrator  │  人类Shell │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ CLI / JSON / Piped stdout
┌──────────────────────────────────────▼───────────────────────────────────────┐
│                          ag-cli CLI Layer (接口层)                            │
│  commands: run · send · wait · read · ls · get · label · kill · rm           │
│            templates · events · status · schema · --skill                    │
│  cross-cutting: TTY/JSON 输出路由 · 统一错误映射与退出码 (0/1/2/3/4/124)       │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼───────────────────────────────────────┐
│                         Core Domain Layer (核心领域层)                        │
│  • TargetResolver       : name / cN / uuid-prefix / uuid 解析                 │
│  • StateMachine         : Observed Facts 五态推导 + Turn Watermark 防竞态     │
│  • WaitEngine           : FSWatcher (kqueue) + 增量 byte offset + 超时 check-in│
│  • EnvelopeInjector     : <ag-cli from="..." reach="..."> 正向与跨界回调信封  │
│  • TemplateEngine       : ~/.config/ag-cli/templates/*.md 解析与渲染          │
└───┬──────────────────────┬───────────────────────┬───────────────────────┬───┘
    │                      │                       │                       │
┌───▼───────────┐  ┌───────▼────────┐  ┌───────────▼──────────┐  ┌─────────▼───────┐
│ Daemon        │  │ AgentApi       │  │ Antigravity          │  │ StateStore      │
│ Discovery     │  │ Client         │  │ Storage Reader       │  │ (Local SQLite)  │
│               │  │                │  │                      │  │                 │
│ 扫描 daemon/  │  │ 注入LS地址与   │  │ • summaries.db (RO)  │  │ ~/.local/share/ │
│ hub_*.json    │  │ CSRF后调用     │  │ • transcript.jsonl   │  │ ag-cli/         │
│ 校验 PID 存活 │  │ agentapi CLI   │  │ • transcript_full    │  │ state.db (RW)   │
│ 探测端口健康  │  │ 或直连 HTTP    │  │ • brain/<id>/ 产物   │  │ 别名/标签/水位线 │
└───────────────┘  └────────────────┘  └──────────────────────┘  └─────────────────┘
```

### 4.1 关键通道分工
- **控制面（写操作）**：通过 `DaemonDiscovery` 获取本机存活的 `language_server` 端口与 `csrfToken`，优先经由官方 `agentapi` 二进制（或直连 `http://localhost:<httpPort>/exa.language_server_pb.LanguageServerService/*`）创建会话、注入消息、查询元数据。
- **观测面（读操作）**：以只读模式读取 `~/.gemini/antigravity/conversation_summaries.db` 获取全局索引，并通过增量偏移量（byte offset）监听与解析 `brain/<conv_id>/.system_generated/logs/transcript.jsonl`（按需回溯 `transcript_full.jsonl`）获取实时步骤、推理状态与 Token 消耗。
- **元数据面（包装层自有状态）**：`ag-cli` 自身维护轻量级 `~/.local/share/ag-cli/state.db`，仅存放 Antigravity 原生数据库不提供的本地包装元数据（短 ID `cN` 自增分配、全局唯一别名 `name`、用户自定义 `labels`、父子/跨界调用关联、`watermark_step` 投递水位线）。

---

## 5. 关键架构决策（ADR）与技术栈选型

### ADR-01：实现语言与运行时选型（已锁定决策 D1）

| 评估维度 | 方案 A：TypeScript + Bun（**已锁定**） | 方案 B：Rust（已放弃） |
| --- | --- | --- |
| **SQLite WAL 读取** | 统一采用 Node/Bun 原生内置 `import { DatabaseSync } from "node:sqlite"` 与 `node:http`，零 C++ 原生编译依赖，Node（Vitest）与 Bun 运行时均开箱即用 | 需引入 `rusqlite`（bundled SQLite 编译耗时增加） |
| **JSON / JSONL 处理** | 原生极速 `JSON.parse` + TS 类型系统天然契合 `transcript.jsonl` | 需维护大量 `serde` 动态字段映射（Antigravity JSONL 字段多且易增量演进） |
| **文件系统监听** | `fs.watch` / `node:fs` 原生支持 macOS `kqueue`/`FSEvents` | `notify` crate，稳定性同样良好 |
| **产物分发形式** | 双形态支持：NPM 包入口 `bin: { "ag-cli": "./dist/index.js" }` 与 `bun build --compile` 单二进制 `dist/ag-cli` | `cargo build --release` 输出单一原生二进制 |
| **工程规范与生态对齐** | 与个人仓及 `base-ci` v2026.15 12 槽质量体系、Biome、Vitest 完全一致 | 与参考仓库 `herdr-core` 同构，适合极低内存/跨 Windows 分发 |
| **结论** | **已锁定（D1）**：开发迭代快、JSONL 协议演进韧性强、同时支持 `npm/bunx` 与单二进制安装到 `~/.local/bin/ag-cli` | 仅作架构对照参考 |

### ADR-02：无常驻自研 Daemon，复用 Antigravity 已有服务
- 与 `herdr-core` 需要自己维护 PTY holder 和后台 daemon 不同，Antigravity 的 `language_server` 本身已经是宿主机上的常驻后台进程（由 Antigravity IDE 或独立守护进程管理），且所有会话轨迹实时持久化到磁盘。
- 因此 `ag-cli` 自身**不需要运行常驻后台守护进程**，每次命令执行都是一次轻量级无状态启动 + 本地状态库读写（`ag-cli wait` 和 `ag-cli events` 在调用期内通过 `fs.watch` 阻塞监听），架构复杂度与崩溃恢复面大幅收敛。

### ADR-03：交互通道选择 `agentapi` + 局部 HTTP RPC 补位
- 创建会话（`new-conversation`）、发送消息（`send-message`）、查元数据（`get-conversation-metadata`）优先复用官方 `agentapi` 入口并注入发现的环境变量，保证随 Antigravity App 版本升级自动兼容内部 Protobuf 协议变化。
- 仅在 `agentapi` 尚未暴露的功能上（例如**中断正在运行的会话** `CancelCascadeInvocation`、`ReadProject` 解析工作区绑定的 `project_id` 等），经由 HTTP Connect Endpoint（`http://localhost:<httpPort>/exa.language_server_pb.LanguageServerService/<Method>` + `x-codeium-csrf-token`）补位，并在失败时给出清晰降级提示。
