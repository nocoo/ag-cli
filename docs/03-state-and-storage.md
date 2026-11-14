# 03 · 状态机、水位线与本地存储

> 状态：`v0.3-locked`（2026-11-14 · 已锁定包名 `ag-cli` 与存储规范）
> 索引：[docs/README.md](./README.md)
> 前置文档：[01-overview-and-architecture.md](./01-overview-and-architecture.md) · [02-cli-and-protocol.md](./02-cli-and-protocol.md)

---

## 1. Observed Facts Only 原则

参考 `herdr-core` 的第一铁律：**所有状态均从可观测事实推导，绝不靠猜。**
- 不通过 LLM 二次总结判断会话是否完成。
- 不依赖对模型自然语言回复中 `"DONE"`、`"完成"` 等脆弱文本关键词的正则猜测。
- 状态完全由以下三类结构化本地数据源联合推导：
  1. **Antigravity 索引库**（`conversation_summaries.db`）：`status`、`not_fully_idle`、`killed`、`step_count`。
  2. **实时轨迹流**（`brain/<conv_id>/.system_generated/logs/transcript.jsonl`）：各 step 的 `step_index`、`type`、`status`、`tool_calls`、Artifacts 写入轨迹。
  3. **`ag-cli` 本地投递水位线**（`state.db`）：`watermark_step` 与 `terminated` 标记。

---

## 2. 五态状态机推导真值表

为了对外提供与 `hc`（OSC 7501）完全一致的五态心智（`idle` / `working` / `done` / `blocked` / `error`），`ag-cli` 按如下**优先级顺序**对单条会话进行纯函数推导（决定逻辑与 I/O 完全分离）：

| 优先级 | 推导状态 | 可观测事实判定条件 | 语义说明 |
| --- | --- | --- | --- |
| **1** | `error` | `summaries.killed == 1` **OR** `state.terminated == 1` **OR** 最新一轮存在 `step.status == "ERROR"` 且其后无新 `USER_INPUT`/`SYSTEM_MESSAGE` 恢复 | 会话被终止或步进报错中断，需 `ag-cli read --steps` 排查 |
| **2** | `blocked` | 尾部非 `GENERIC` 挂起或最新 step `status == "WAITING"` **OR** 尾部 `tool_calls` 中含 `ask_question` 且无后续回复 **OR** 存在 `RequestFeedback: true` 的待确认产物且模型停留在等待确认 | 等待人类或上游 Agent 审批/回答问题。`ag-cli send` 默认拒绝注入（需 `--force`） |
| **3** | `working` | `summaries.status == "CASCADE_RUN_STATUS_RUNNING"` **OR** `summaries.not_fully_idle == 1`（且未满足 `blocked`） **OR** `transcript` 尾部 step `status == "RUNNING"` **OR** `maxStepIndex < state.watermarkStep`（新投递尚未落地或尚未完成） | Agent 正在推理、调用工具或处于后台等待恢复中 |
| **4** | `done` | `summaries.status == "CASCADE_RUN_STATUS_IDLE"` **AND** `maxStepIndex >= state.watermarkStep` **AND** 最近一个用户/系统入站消息之后存在 `type == "PLANNER_RESPONSE"` 且 `status == "DONE"`（无未闭合 `tool_calls`） | 至少完成过一轮有效交互且当前稳定停靠在最终回复 |
| **5** | `idle` | 会话刚创建且尚未产生有效工具/回复轮次，或 `step_count == 0` 且无挂起水位线 | 空闲待命状态（Turn 0） |

> **工程边界提示**：若 Antigravity 进程异常崩溃导致 `transcript.jsonl` 末尾停留在 `RUNNING` 而 `language_server` 已不存在，`ag-cli status` 会提示 `daemon_unavailable`，避免 `ag-cli wait` 将死进程误判为持续 `working`。

---

## 3. 防竞态投递水位线（Turn Watermark）算法

### 3.1 为什么必须引入 Watermark？
在 Antigravity 中，向一个原本处于 `done`（`CASCADE_RUN_STATUS_IDLE`）的会话发送 `agentapi send-message` 时，存在典型的 **异步投递竞态窗口**：

```text
Caller (ag-cli)            agentapi / language_server          conversation_summaries.db / transcript.jsonl
   │                                  │                                          │
   ├─ 1. pre-read maxStep = 63 ──────►│                                          │
   ├─ 2. record watermark = 64        │                                          │
   ├─ 3. send-message("执行任务") ───►│                                          │
   │◄─ 4. HTTP 200 OK (立即返回) ─────┤                                          │
   │                                  ├─ (5~50ms 异步入队延迟)                     │
   ├─ 6. 若直接查状态: 仍为 IDLE ! ───┼─────────────────────────────────────────►│ (step 仍停在 63!)
   │   (无水位线会瞬间误判为 done!)     │                                          │
   │                                  ├─ 7. 落盘 step 64 (SYSTEM_MESSAGE) ──────►│
   │                                  ├─ 8. 状态切为 RUNNING, 执行 step 65..70 ──►│
   │                                  ├─ 9. 落盘 step 71 (PLANNER_RESPONSE/DONE)►│
   │                                  ├─ 10. 状态回到 IDLE ──────────────────────►│
   ├─ 11. WaitEngine 观测到:          │                                          │
   │      • step >= 64 (入站已消费)    │                                          │
   │      • step 71 == PLANNER/DONE   │                                          │
   │      • status == IDLE            │                                          │
   │◄─ 12. 准确返回 reason: "done" ───┴──────────────────────────────────────────┘
```

### 3.2 算法规则
1. **发送前采样**：在 `ag-cli run`（`reuse` 模式）或 `ag-cli send` 调用 `agentapi` 前，先读取当前 `transcript.jsonl` 的最大 `step_index`（若文件尚不存在记为 `-1`），记为 `prevMaxStep`。
2. **锁定目标水位线**：将期望观测到的新入站消息门槛写入 `state.db`：`watermark_step = prevMaxStep + 1`（注：对于 `new-conversation`，`watermark_step = 0`，即必须至少看到 `step_index = 0` 的 `USER_INPUT` 及后续 `PLANNER_RESPONSE`）。
3. **完成判定条件**：
   - 在 `transcript.jsonl` 中已实际观察到 `step_index >= watermark_step` 且 `type IN ("USER_INPUT", "SYSTEM_MESSAGE")` 的入站步骤；
   - 在该入站步骤**之后**，出现了 `type == "PLANNER_RESPONSE"` 且 `status == "DONE"` 且无未决 `tool_calls` 的最终步骤；
   - 并且 `conversation_summaries.db` 中该会话 `status == "CASCADE_RUN_STATUS_IDLE"` 且 `not_fully_idle == 0`。
4. **水位线清零/推进**：一旦判定 `done` 并更新 `last_turn`，维持 `watermark_step` 为当前已观测入站 step index，保证下次 `ag-cli get` / `ag-cli ls` 幂等得出 `done`。
5. **投递回滚的所有权**：每次投递通过 `delivery_seq` 单调递增的投递序号登记（`beginDelivery`），发送失败时的回滚（`rollbackDelivery`）仅在该序号仍归本次投递所有时才恢复水位线或删除新建注册行；标签写入同样推进序号，防止并发投递的回滚误删他人成果。同名创建通过 `name_reservations` 在派发前互斥。

---

## 4. 零轮询事件驱动引擎（FSWatcher + 增量解析）

对齐 `hc` "绝不用 sleep 轮询"的工程原则，`ag-cli wait` 与 `ag-cli events` 采用操作系统级文件事件监听 + 增量字节偏移解析：

### 4.1 双路径监听策略
1. **轨迹目录监听**：使用 `fs.watch` 监听 `~/.gemini/antigravity/brain/<conv_id>/.system_generated/logs/`（若目录尚未创建，先监听 `~/.gemini/antigravity/brain/` 等待子目录出现）。
2. **WAL 事务监听**：同时监听 `~/.gemini/antigravity/conversation_summaries.db-wal` 的变更事件，以第一时间捕捉 `CASCADE_RUN_STATUS_RUNNING` → `CASCADE_RUN_STATUS_IDLE` 的状态切换。
3. **20ms 事件防抖与 2s 兜底校验**：
   - 单次 step 写入可能触发多次连续文件变动事件，通过 20ms debounce 合并一次状态重算。
   - 若 macOS FSEvents 在极端 IO 压力下丢失或合并事件，每 2000ms 执行一次极轻量的 `stat`（检查文件 `size`/`mtimeMs` 与 SQLite `PRAGMA data_version`）兜底，仅在变化时触发解析，平时几乎零 CPU 占用。

### 4.2 O(1) 增量 Byte Offset 解析
- 长会话的 `transcript.jsonl` 可能达到数 MB。`TranscriptReader` 在内存状态中保存当前已解析完成的 `byteOffset`：
  - 每次触发更新时，直接 `fs.open` + `read(offset..end)` 读取新增字节；
  - 按 `\n` 切分完整行（若尾部为半行则暂存缓冲等待下一次刷盘）；
  - 单步耗时 `< 1ms`，彻底避免反复整文件重解析。
- 对于 `ag-cli read --full`，先根据 `transcript.jsonl` 定位目标 `step_index` 列表及包含 `truncated_fields` 的行号，再按相同行号/索引精准提取 `transcript_full.jsonl` 中对应行的完整 `content` / `thinking` / `tool_calls`。

---

## 5. 本地存储与路径规范

### 5.1 环境变量与沙箱隔离

| 变量名 | 默认路径 | 用途说明 |
| --- | --- | --- |
| `AG_CLI_HOME` | `~/.local/share/ag-cli` | 存放 `ag-cli` 自有 `state.db`（测试时指向临时目录） |
| `AG_CLI_CONFIG_DIR` | `~/.config/ag-cli` | 存放用户配置 `config.toml` 与角色模板 `templates/` |
| `AG_CLI_ANTIGRAVITY_DIR` | `~/.gemini/antigravity` | Antigravity 数据根目录（测试时指向模拟沙箱目录，绝不污染宿主机真实状态） |
| `AG_CLI_AGENTAPI_BIN` | `<AG_CLI_ANTIGRAVITY_DIR>/bin/agentapi` | 覆盖 `agentapi` 可执行文件路径（测试时注入 Mock 替身） |
| `AG_CLI_CALLER_ID` | 自动探测 `$ANTIGRAVITY_CONVERSATION_ID` | 显式覆盖当前调用者会话 ID（如在跨层脚本中手动绑定父会话） |

### 5.2 `state.db` 表结构（SQLite WAL 模式）

```sql
CREATE TABLE IF NOT EXISTS conversations (
  short_id        INTEGER PRIMARY KEY AUTOINCREMENT, -- 映射为 c1, c2, ...
  conversation_id TEXT NOT NULL UNIQUE,              -- Antigravity UUID
  name            TEXT UNIQUE,                       -- 人类可读唯一别名（如 deps-clip）
  parent_id       TEXT,                              -- 父会话 UUID 或 hc:<terminal_id>
  cwd             TEXT,                              -- 关联工作目录
  project_id      TEXT,                              -- 关联 Antigravity projectId
  model           TEXT,                              -- 创建时指定的模型
  watermark_step  INTEGER NOT NULL DEFAULT -1,       -- 投递防竞态水位线
  last_turn       INTEGER NOT NULL DEFAULT 0,        -- 已完成轮次计数
  terminated      INTEGER NOT NULL DEFAULT 0,        -- 1 表示已 ag-cli kill
  delivery_seq    INTEGER NOT NULL DEFAULT 0,        -- 投递序号（回滚所有权判定）
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
  conversation_id TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  PRIMARY KEY (conversation_id, key),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS name_reservations (
  name       TEXT PRIMARY KEY,                       -- 并发 run --name 的创建互斥
  token      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_id);
CREATE INDEX IF NOT EXISTS idx_labels_kv ON labels(key, value);
```

### 5.3 Antigravity `conversation_summaries.db` 只读访问约定
- 统一通过 Node/Bun 原生 `import { DatabaseSync } from "node:sqlite"` 打开连接，并设置 `PRAGMA busy_timeout = 3000` 与 `PRAGMA query_only = ON` 实现**引擎级只读**。
  - 实现说明：`readOnly: true` 文件级只读连接在 Bun 运行时对「无活跃写连接、因而缺少 `-shm` 文件」的 WAL 库会在查询阶段报 `unable to open database file`；`PRAGMA query_only = ON` 在 Node 与 Bun 下行为一致，且同样拒绝一切写入。
  - 该偏差只涉及连接打开方式，"绝不写入 Antigravity 原生库" 的约束由 `query_only` 在 SQLite 引擎层强制保证。
- `ag-cli` **绝对禁止**向 `conversation_summaries.db` 或 `conversations/<id>.db` 执行任何 `INSERT`/`UPDATE`/`DELETE` 写入操作，以免破坏 Antigravity `language_server` 的内部事务锁或状态一致性。

---

## 6. 角色模板（Templates）存储规范

参考 `hc` 的 `~/.config/herdr-core/templates/<name>.md`，`ag-cli` 支持在 `~/.config/ag-cli/templates/<name>.md` 声明可复用专家角色：

```markdown
---
name: browser-verifier
description: Run UI verification in Antigravity built-in browser and report screenshots
model: gemini-3.8-flash-medium
profile: verifier
cwd: /Users/nocoo/workspace/personal/clip
---
You are a dedicated browser QA verifier.
Use your built-in `browser` subagent to open the target URL, verify interactive flows,
save screenshots to your artifact directory, and return concise pass/fail evidence.
Do not modify repository source code.
```

**模板渲染规则**：
- `ag-cli run <template> "<task>"` 读取对应模板文件的 YAML Frontmatter：
  - `model`、`profile`、`cwd` 作为默认值，命令行显式传参（如 `--model pro`）优先级高于模板默认值。
  - Markdown 正文作为 System/Role Preamble，与用户的 `<task>` 拼合（中间以空行分隔），再注入 `<ag-cli>` 协同信封后一并作为首条消息发送。
