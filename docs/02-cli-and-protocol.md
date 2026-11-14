# 02 · CLI 接口与交互协议

> 状态：`v0.2-locked`（2026-11-14 · 已锁定命名与协议）
> 索引：[docs/README.md](./README.md)
> 前置文档：[01-overview-and-architecture.md](./01-overview-and-architecture.md)
> 详细状态机制：[03-state-and-storage.md](./03-state-and-storage.md)

---

## 1. CLI 顶层概览

`tg` 的子命令命名、分组及输出心智严格对齐 `hc --help`：

```text
tg - dispatch tasks to local Antigravity conversations and collect results

Usage: tg <command> [options]

Conversations
  run [template] <prompt>     Start (or --reuse) a conversation and wait (--bg: don't wait)
  ls                          List active conversations (--all: include killed/unmanaged)
  get [c]                     Show observed state, status, tokens, and artifacts
  read [c]                    Print the latest reply and artifacts (--steps: show trace)
  kill <c>                    Cancel a running turn or mark conversation terminated
  rm <c>                      Remove a conversation from tg registry (--purge-brain: delete files)
  label <c> <k=v...>          Set or clear labels (key= removes)

Talk & Wait
  send <c> <text>             Send a message to a conversation (--wait: wait for turn completion)
  interrupt <c>               Cancel the currently running turn in a conversation
  wait [c]                    Wait until done, blocked, or error (--children: any|all)

More
  templates                   List templates (~/.config/team-gravity/templates)
  events                      Follow state and step changes live (JSON Lines when piped)
  status                      Inspect Antigravity daemon, database, and agentapi health
  schema                      Print the CLI/API JSON Schema

<c> is a target like c7, a name (clip-worker), a UUID prefix, or a full UUID.
Piped output is JSON except `run` (text status/summary) and `read` (Markdown reply).
Use `tg <command> --help` for exact arguments.
Agent? Run: tg --skill
```

### 1.1 输出模式契约（TTY vs Piped vs `--json`）

| 命令 | TTY 终端直接运行 | 管道输出（Piped） | 显式传入 `--json` |
| --- | --- | --- | --- |
| `tg run` | 等待时实时进度；结束输出摘要文本 | 同步时输出最终结果文本；`--bg` 时输出单行摘要 | 始终输出完整 JSON 对象 |
| `tg read` | 格式化输出 Markdown 回复与 Artifacts 路径 | 仅输出纯净回复正文（方便重定向到文件或管道） | 输出包含 `reply`、`artifacts`、`steps`、`telemetry` 的完整 JSON |
| `tg ls` / `tg get` / `tg status` / `tg templates` / `tg send` / `tg wait` | 人类可读的紧凑表格或键值摘要 | **自动切换为 JSON**（对齐 `hc` 设计） | 始终输出 JSON |
| `tg events` | 人类可读的事件时间线 | 逐行输出 JSON Lines（NDJSON） | 逐行输出 JSON Lines（NDJSON） |

### 1.2 NPM 包名与 CLI 命令名实测及决议（D2）

在锁定包名与二进制命令名前，通过项目环境允许的 NPM 镜像（`https://packagefeedproxy.microsoft.io/npm/`）与本机 `PATH` 进行了实测排查：

| 候选名称 | NPM 注册表状态 | 本机 `PATH` 占用 | 说明 |
| --- | --- | --- | --- |
| `team-gravity` | **可用（HTTP 404）** | 无冲突 | 与仓库同名，语义直观，全局唯一 |
| `@nocoo/team-gravity` | **可用（HTTP 404）** | 无冲突 | 个人 Scope 备选包名，同样未占用 |
| `@nocoo/tg` / `tgrav` / `ag-cli` | **可用（HTTP 404）** | 无冲突 | 备选短包名 |
| `tg` | **已被占用（HTTP 200）** | 无冲突 | NPM 包名已被第三方占坑，但本机可执行命令完全空闲 |
| `antigravity-cli` | **已被占用（HTTP 200）** | — | NPM 包名已被占用 |

**已锁定决议（D2）**：
- **NPM 包名**：使用 `team-gravity`（或个人 Scope 变体 `@nocoo/team-gravity`；`package.json` `"name"` 锁定为 `"team-gravity"`）。
- **CLI 命令入口**：在 `package.json` `"bin"` 同时暴露短命令 `"tg"`（日常主力命令，对齐 `hc`）与全称别名 `"team-gravity"`：`{ "tg": "./dist/index.js", "team-gravity": "./dist/index.js" }`；单二进制构建默认输出 `dist/tg`。

---

## 2. 寻址协议（Target Resolution `<c>`）

任何接受 `<c>`（Conversation Target）参数的命令按以下**严格优先级**解析目标：

1. **精确别名（`name`）**：在 `state.db` 活跃会话（或开启 `--all` 时含已归档）中匹配唯一 `name`（校验规则与 `hc` 一致：`^[a-z0-9][a-z0-9_-]{0,31}$`）。
2. **本地短 ID（`cN`）**：如 `c1`、`c7`、`c42`（匹配 `^c[0-9]+$`），对应 `state.db` 自增主键。
3. **UUID 唯一前缀**：长度 `>= 4` 的十六进制前缀（如 `990014f6`），同时扫描 `state.db` 与 `conversation_summaries.db`；若匹配多条则报错 `ambiguous_target` 并列出候选 ID 与标题，绝不猜测。
4. **完整 36 位 UUID**：直接匹配精确 `conversation_id`（即使该会话最初不是由 `tg` 创建，只要存在于 Antigravity 数据库或 `/brain/` 目录中即可接管交互）。

### 默认目标推导
- 当从 Antigravity 会话内部 shell 调用（存在环境变量 `ANTIGRAVITY_CONVERSATION_ID`）且省略 `[c]` 时：
  - `tg get`、`tg read` 默认指向当前自身会话；
  - `tg wait --children <any|all>` 默认等待当前会话派生的所有子会话。
- 在外部终端调用且省略 `[c]` 时：若未指定 `--children` 或目标，报错 `missing_target`（退出码 `2`）。

---

## 3. 逐命令详细规范

### 3.1 `tg run` — 创建或复用会话并派发任务

```text
Usage: tg run [OPTIONS] [TEMPLATE_OR_PROMPT] [PROMPT]
```

**参数解析逻辑**：
- 仅传入 1 个位置参数时，视为 `<PROMPT>`。
- 传入 2 个位置参数且第 1 个匹配 `~/.config/team-gravity/templates/<name>.md` 时，第 1 个为 `<TEMPLATE>`，第 2 个为 `<PROMPT>`；否则报 `template_not_found`。

**选项清单**：

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--bg` | boolean | `false` | 派发后立即返回，打印短 ID 与 UUID（同 `hc run --bg`）。默认同步等待首轮结束 |
| `--name <NAME>` | string | 无 | 分配人类可读唯一名称（如 `deps-clip`）。默认若同名活跃会话已存在则报错 `name_conflict` |
| `--reuse` | boolean | `false` | 必须与 `--name` 联用：若同名且未终止（`killed = 0`）的会话已存在，**直接复用**该会话并通过 `send-message` 派发本轮任务（彻底替代手工查 SQL）；若不存在则新建并绑定该名称 |
| `--cwd <DIR>` | path | 当前工作目录 | 目标工作目录；自动匹配 Antigravity 中已注册的 `projectId` 并注入 `ANTIGRAVITY_PROJECT_ID`，同时在首条消息上下文标注工作路径 |
| `--model <MODEL>` | string | `flash` | 模型档位或精确 ID，如 `flash`、`flash_lite`、`pro`、`gemini-3.8-flash-medium` |
| `--profile <PROFILE>` | string | 无 | 透传给 `agentapi new-conversation --profile` |
| `--title <TITLE>` | string | 自动生成 | 在 Antigravity 侧边栏显示的会话标题（未传时优先取 `--name`，否则截断 prompt 前 40 字符） |
| `--label <K=V>` | string[] | `[]` | 可重复传参，为会话打标签（如 `--label task=deps-fix --label repo=clip`） |
| `--parent <C>` | string | 自动探测 | 显式指定父会话（未传时若检测到 `$ANTIGRAVITY_CONVERSATION_ID` 或 `$HC_TERMINAL_ID` 则自动记录） |
| `--no-parent` | boolean | `false` | 不绑定任何父子关系 |
| `--no-notify` | boolean | `false` | 不在消息尾部注入 `<tg ... reach="...">` 回调信封 |
| `--raw` | boolean | `false` | 保持 prompt 原文一字不改，不注入 `<tg>` 信封和工作区声明 |
| `--timeout <SEC>` | integer | `180` | 同步模式（无 `--bg`）等待超时时间（秒）。超时后会话继续运行，返回退出码 `124` |
| `--json` | boolean | 自动 | 强制输出 JSON |

**`tg run --bg --json` 返回示例**：

```json
{
  "shortId": "c12",
  "conversationId": "990014f6-f6d1-4567-adcf-6182cead394c",
  "name": "deps-clip",
  "title": "deps-clip",
  "reused": false,
  "model": "gemini-3.8-flash-medium",
  "projectId": "e80ab9ca-b14a-4dc9-9c0c-e6a931f333e4",
  "cwd": "/Users/nocoo/workspace/personal/clip",
  "watermarkStep": 0,
  "status": "working"
}
```

**`tg run` 同步模式超时行为**：
- 超过 `--timeout` 秒未完成时，输出提示 `[tg] still working as c12 (deps-clip, 990014f6-...)` 并以退出码 `124` 退出；Antigravity 会话在后台保持运行，后续可用 `tg wait c12` 继续等待。

---

### 3.2 `tg send` — 向已有会话发送指令

```text
Usage: tg send [OPTIONS] <C> <TEXT>
```

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `--if <STATUS>` | enum (`idle` \| `done` \| `working`) | 前置状态断言；不满足则拒绝发送并返回退出码 `3`（防并发踩踏） |
| `--force` | boolean | 允许向当前处于 `blocked`（等待人工确认/回答问题）状态的会话发送消息 |
| `--wait` | boolean | 发送后同步阻塞等待本轮执行完成（等价于发送后立即执行 `tg wait <C>`） |
| `--timeout <SEC>` | integer | 配合 `--wait` 使用，默认 `180` 秒 |
| `--title <TITLE>` | string | 透传 `agentapi send-message --title` |
| `--no-notify` / `--raw` | boolean | 同 `tg run` |
| `--json` | boolean | 输出发送回执 JSON（含更新后的 `watermarkStep`） |

**安全保护规则**：
- 若目标会话当前处于 `blocked` 且未传 `--force`，`tg send` 拒绝投递并返回错误码 `blocked_conversation`（提示先 `tg read` 查看问题或审批）。
- 若目标会话当前处于 `working` 且未显式传 `--if working` 或 `--force`，默认仍允许排队发送（Antigravity 原生支持 queued user input），但在返回 JSON 中显式标记 `"queued": true`。

---

### 3.3 `tg wait` — 事件驱动等待会话完成

```text
Usage: tg wait [OPTIONS] [C]
```

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `--children <MODE>` | enum (`any` \| `all`) | 等待当前 caller（或 `<C>`）名下所有活跃子会话。<br>`any`：任一子会话到达 `done`/`blocked`/`error` 或当前 caller 收到入站新消息即返回。<br>`all`：直到所有子会话均脱离 `working` 状态才返回 |
| `--timeout <SEC>` | integer | 超时秒数，默认 `180`（`0` 表示无限等待）。超时返回退出码 `124` |
| `--json` | boolean | 输出结构化等待结果 |

**`tg wait --json` 返回结构**：

```json
{
  "reason": "done",
  "target": {
    "shortId": "c12",
    "conversationId": "990014f6-f6d1-4567-adcf-6182cead394c",
    "name": "deps-clip",
    "status": "done",
    "turn": 2,
    "stepCount": 64
  },
  "durationMs": 48210,
  "latestReplyPreview": "已完成 @biomejs/biome 与 hono 升级并合并 PR #238..."
}
```

`reason` 枚举严格限定为以下 5 种：
- `done`：目标完成本轮（已越过投递水位线且尾部为稳定态 `PLANNER_RESPONSE`）
- `blocked`：目标遇到审批请求或调用 `ask_question`，需人工或调用方介入
- `error`：目标步进发生错误或被外部终止（`killed = 1` / `ERROR`）
- `message`：在等待子会话期间，caller 自己收到了入站消息（对齐 `hc wait --children any`）
- `timeout`：达到 `--timeout` 上限（退出码 `124`）

---

### 3.4 `tg read` — 读取结构化回复、步骤轨迹与产物

```text
Usage: tg read [OPTIONS] [C]
```

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--turns <N>` | integer | `1` | 读取最近 `N` 轮对话的最终回复 |
| `--steps` | boolean | `false` | 展开显示步骤流水（含 `[think]`、`[tool]`、`[system]`、`[reply]`） |
| `--lines <N>` | integer | `50` | 配合 `--steps` 使用，限制最近输出条数 |
| `--full` | boolean | `false` | 自动关联读取 `transcript_full.jsonl`，恢复在 `transcript.jsonl` 中被 `truncated_fields` 截断的长文本 |
| `--artifact <NAME>` | string | 无 | 直接读取 `~/.gemini/antigravity/brain/<conv_id>/<NAME>` 文件正文 |
| `--json` | boolean | 自动 | 输出完整 JSON（含 `turns[]`, `artifacts[]`, `telemetry`） |

**`tg read <c>` 默认人类可读输出示例**：

```markdown
# c12 (deps-clip) · Turn 2 · done

已完成 `nocoo/clip` 的依赖批量升级并合并 PR #238。

---
Artifacts (1):
- deps_fix_report_20261114.md  (/Users/nocoo/.gemini/antigravity/brain/990014f6-.../deps_fix_report_20261114.md)
```

**`tg read <c> --json` 输出 Schema 核心字段**：

```json
{
  "shortId": "c12",
  "conversationId": "990014f6-f6d1-4567-adcf-6182cead394c",
  "name": "deps-clip",
  "status": "done",
  "turn": 2,
  "reply": "已完成 `nocoo/clip` 的依赖批量升级...",
  "artifacts": [
    {
      "name": "deps_fix_report_20261114.md",
      "path": "/Users/nocoo/.gemini/antigravity/brain/990014f6-f6d1-4567-adcf-6182cead394c/deps_fix_report_20261114.md",
      "bytes": 4820,
      "modifiedAt": "2026-11-14T02:27:38Z"
    }
  ],
  "telemetry": {
    "inputTokens": 18420,
    "cacheReadTokens": 142500,
    "outputTokens": 2310,
    "stepCount": 64
  }
}
```

---

### 3.5 `tg ls` / `tg get` / `tg label` / `tg kill` / `tg rm` / `tg interrupt`

- **`tg ls [OPTIONS]`**：
  - 默认展示所有由 `tg` 管理或活跃中的会话（`--all` 展示 Antigravity 库中所有历史与非托管会话）。
  - 支持 `--label <K=V>`（可多次叠加 AND 过滤）、`--children`（仅看当前 caller 子会话）、`--status <idle|working|done|blocked|error>`。
  - TTY 表格列：`SHORT` | `NAME` | `STATUS` | `TURN` | `STEPS` | `TITLE` | `PROJECT/CWD` | `UPDATED`。
- **`tg get [C]`**：
  - 展示单条会话完整观测快照（ID、别名、标题、推导状态、父会话、Labels、Token 累加、Watermark、Artifact 列表、最新错误详情）。
- **`tg label <C> <K=V>...`**：
  - 写入或删除（`key=`）`state.db` 中的标签，支持同名覆盖。
- **`tg interrupt <C>`**：
  - 向本地 `language_server` 调用 `CancelCascadeInvocation` RPC 中断当前正在进行的 turn（保留会话上下文，使状态退回可继续交互态）；若 RPC 不可用，返回明确错误提示，不假装成功。
- **`tg kill <C>`**：
  - 先尝试 `CancelCascadeInvocation` 停止运行中步骤，然后在 `state.db` 标记该会话 `terminated = 1`（使其脱离默认 `tg ls` 与 `--reuse` 池）。
- **`tg rm <C> [--purge-brain]`**：
  - 从 `tg` 本地 `state.db` 移除记录并释放 `name` 别名；**默认绝对不删除** `~/.gemini/antigravity/brain/<conv_id>` 与 `.db` 原生数据，仅在显式传入 `--purge-brain` 时才清理对应的 Artifact 目录。

---

### 3.6 `tg events` / `tg templates` / `tg status` / `tg schema` / `tg --skill`

- **`tg events [OPTIONS]`**：
  - 过滤参数：`--target <C>`、`--children-of <C>`、`--label <K=V>`。
  - 持续输出事件流（Piped / `--json` 下为 NDJSON）：`created`、`status`、`step`、`turn`、`artifact`、`heartbeat`（每 15s）。
- **`tg templates`**：
  - 扫描 `~/.config/team-gravity/templates/*.md`，输出模板名、默认模型、默认 `profile` 及描述。
- **`tg status`**（别名 `tg doctor`）：
  - 检查：① `~/.gemini/antigravity/daemon/hub_*.json` 是否存在且 PID 存活、`/healthz` 是否可达；② `conversation_summaries.db` 是否可读；③ `~/.gemini/antigravity/bin/agentapi` 是否存在可执行；④ `state.db` 状态。
- **`tg schema`**：
  - 输出全量命令参数与 JSON 返回结构的 JSON Schema / OpenRPC 描述文档，方便外部工具自动生成客户端绑定。
- **`tg --skill`**：
  - 向 stdout 打印精炼自包含的 Agent 操作手册（详见 [04-skill-and-workflows.md](./04-skill-and-workflows.md)）。

---

## 4. 跨 Agent 协同信封协议（`<tg>` Envelope）

参考 `hc` 的 `<hc from="..." reach="...">` 机制，`tg` 在 `tg run` 与 `tg send` 派发任务时（除非指定 `--no-notify` 或 `--raw`），自动探测调用者上下文并在消息头部/尾部注入轻量协同信封：

### 4.1 场景 A：Antigravity 会话 → Antigravity 会话（同构调用）
当环境变量存在 `ANTIGRAVITY_CONVERSATION_ID`（如 `a464a19f-...`）时，注入：

```text
<tg from="c3 a464a19f" cwd="/Users/nocoo/workspace/personal/clip" reach="tg send c3 \"<summary or artifact path>\" when done or blocked">
请升级 @biomejs/biome 并创建 PR。
</tg>
```

### 4.2 场景 B：`hc` 终端里的 Bot（如 `pi` / Claude Code） → Antigravity 会话（异构跨界调用）
当外部无 `ANTIGRAVITY_CONVERSATION_ID` 但检测到 `$HC_TERMINAL_ID`（如 `t7`）时，自动生成跨界回调指令：

```text
<tg from="hc:t7" cwd="/Users/nocoo/workspace/personal/clip" reach="hc send t7 \"<summary or artifact path>\" when done or blocked">
请在浏览器验收 localhost:3000 登录流并将截图路径回传。
</tg>
```

这样被调用的 Antigravity 会话完成后，只需执行信封中给定的 `reach` 命令，即可把最终结果和 Artifact 路径精确送回 `hc` 终端里的 `pi` 或另一个 Antigravity 会话，实现完全异步、零轮询的网格协同。

---

## 5. 错误结构与退出码契约

在 `--json` 或管道模式下，所有错误均以标准 JSON 格式输出到 `stderr`：

```json
{
  "error": {
    "kind": "precondition_failed",
    "message": "conversation c12 (deps-clip) is currently working, expected idle",
    "hint": "Run `tg wait c12` first or omit `--if idle` to queue the message."
  }
}
```

| 退出码 | 错误类别 (`kind`) | 触发条件 |
| --- | --- | --- |
| `0` | — | 成功完成 |
| `1` | `runtime_error` / `not_found` / `ambiguous_target` / `name_conflict` / `blocked_conversation` | 目标不存在、名称冲突、会话处于 `blocked` 未传 `--force` 等 |
| `2` | `invalid_usage` | 非法命令行参数、非法别名格式、缺少必填目标 |
| `3` | `precondition_failed` | `--if <status>` 状态断言不满足 |
| `4` | `daemon_unavailable` | 未找到存活的 `language_server` daemon 或 `agentapi` 不可用 |
| `124` | `timeout` | `tg run`（同步）或 `tg wait` 到达 `--timeout` 超时（目标仍在后台运行） |
