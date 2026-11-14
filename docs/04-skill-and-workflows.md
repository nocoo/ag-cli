# 04 · 内置 Skill 与协同工作流

> 状态：`v0.3-locked`（2026-11-14 · 已锁定命令 `ag-cli` 与工作流规范）
> 索引：[docs/README.md](./README.md)
> 前置文档：[01-overview-and-architecture.md](./01-overview-and-architecture.md) · [02-cli-and-protocol.md](./02-cli-and-protocol.md) · [03-state-and-storage.md](./03-state-and-storage.md)

---

## 1. `ag-cli --skill` 内置手册全文草案

参考 `hc --skill` 的自包含文档规范，任何外部或内部 Agent 只需执行一次 `ag-cli --skill`，即可获知全部操作规约：

```markdown
# ag-cli manual

`ag-cli` lets coding agents and terminal bots start, reuse, message, wait on,
and read results from local Antigravity conversations.
`<c>` below means a name (`deps-clip`), short ID (`c7`), UUID prefix, or full UUID.
Piped output is JSON except `run` (summary) and `read` (Markdown reply).
Use `ag-cli <command> --help` for exact arguments; `ag-cli --help` lists commands.

## Delegate a task

First check `ag-cli templates`: ready-made roles may include `browser-verifier` or
`researcher`. Use one that fits, or start a conversation directly:

```sh
ag-cli run --bg --name ui-check --cwd /path/to/repo browser-verifier "Verify login flow on http://localhost:3000"
```

- Prefer `--bg` when running multiple tasks or delegating from another agent so
  your shell tool does not block while waiting.
- Use `--reuse --name <name>` for persistent per-repo workers: if a live
  conversation with that name exists, `ag-cli` reuses its context via `send-message`;
  otherwise it creates a new one.
- Give each worker a unique `--name` and `--label task=<slug>`.

## Talk, wait, and collect results

```sh
ag-cli ls                              # active ag-cli-managed conversations (--all: everything)
ag-cli get ui-check                    # observed state, status, turn, tokens, artifacts
ag-cli wait ui-check --timeout 300     # event-driven wait (never sleep or poll)
ag-cli read ui-check                   # latest reply and artifact paths
ag-cli read ui-check --steps --lines 30 # inspect thinking/tool trace
ag-cli send --wait ui-check "Now check dark mode too"
ag-cli interrupt ui-check              # cancel current turn, keep context
```

Wait outcomes (`reason` in JSON):
- `done`: turn finished past the delivery watermark; run `ag-cli read <c>`.
- `blocked`: conversation is waiting for approval or answered `ask_question`;
  inspect with `ag-cli read <c> --steps` before deciding (`send` requires `--force`).
- `error`: execution errored or terminated.
- `timeout` (exit code 124): check-in; worker is still running, call `ag-cli wait` again.
- `message`: with `ag-cli wait --children any`, caller received an incoming message.

## Wait for multiple workers

```sh
ag-cli wait --children any             # return when any child updates or you get a message
ag-cli wait --children all             # return when no child is working
```

## Reporting back (`<ag-cli>` envelope)

If your prompt arrives wrapped in:

```text
<ag-cli from="hc:t7" reach="hc send t7 when done or blocked">...</ag-cli>
```

Execute the exact `reach` command with a concise summary and artifact paths
when you finish or get blocked.

## Cleanup

```sh
ag-cli kill <c> && ag-cli rm <c>       # mark terminated and unregister alias
```

`ag-cli rm` never deletes Antigravity's underlying `/brain/` artifacts unless `--purge-brain` is passed.
```

---

## 2. 三大核心协同工作流详解

### 2.1 工作流一：外部 CLI Bot（`hc` + `pi` / Claude Code）委派任务给 Antigravity

**典型场景**：终端中的 `pi` 擅长高性价比代码实现与重构，但缺乏 Antigravity 原生的 **Built-in Browser Subagent**、**Image Generator** 或特定 Gemini Pro 深度多模态分析能力。此时 `pi` 可将验证或研究子任务委派给本机 Antigravity。

```text
pi (running in hc terminal t7)
   │
   ├─ 1. 本地起 dev server: hc run --bg --name web bun dev
   ├─ 2. 派发浏览器验收给 Antigravity:
   │     ag-cli run --bg --name ui-check --cwd /app --label task=auth \
   │       "用 browser 子代理打开 http://localhost:3000/login 测试登录并截图"
   │     (ag-cli 自动读取 ~/.gemini/antigravity/daemon/hub_*.json，注入 <ag-cli from="hc:t7" reach="hc send t7 ...">)
   │
   ├─ 3. 事件驱动等待 (二选一):
   │     方式 A (同步阻塞等待): ag-cli wait ui-check --timeout 300
   │     方式 B (异步释放自己): pi 继续写后端代码；Antigravity 完成后自动执行 `hc send t7 "..."`
   │
   └─ 4. 提取结构化产物:
         ag-cli read ui-check --json
         -> 直接拿到 reply 正文 + artifacts[].path 截图路径
```

---

### 2.2 工作流二：Antigravity 主控编排多个 Antigravity Worker 会话

以现有的 `deps-fix-orchestrator` 技能为例，对比引入 `ag-cli` 前后的编排复杂度：

#### 改造前（手工胶水模式）
1. 手写 `sqlite3 ~/.gemini/antigravity/conversation_summaries.db "SELECT conversation_id ... WHERE title = '...' AND killed = 0 ..."`。
2. 若不存在，拼装 `agentapi new-conversation` 命令并从 stdout JSON 提取 `conversationId`。
3. 再用 `agentapi send-message` 手工硬编码主控 `ORCH_ID` 和回调命令模板。
4. 通过 `schedule`（每 90–120 秒）唤醒一次，每次手写 Python 脚本读取 `transcript.jsonl` 提取 `input_tokens`、`output_tokens` 和 Artifact 路径。

#### 改造后（`ag-cli` 标准编排模式）

```bash
# 1. 一行完成"查库复用或新建 + 绑定工作区 + 打标签 + 注入回调信封 + 记录水位线"
ag-cli run --bg --reuse \
  --name "deps-clip" \
  --model gemini-3.8-flash-medium \
  --cwd "/Users/nocoo/workspace/personal/clip" \
  --label workflow=deps-fix --label repo=clip \
  "请按 hc-coding-review 规范升级 #236 和 #237，生成报告并创建合并 PR。"

# 2. 事件驱动等待完成（支持单个或 --children all/any 并发编排多仓库）
ag-cli wait deps-clip --timeout 600

# 3. 一行获取完整 Markdown 报告 + Artifacts + Token/耗时 Telemetry JSON
ag-cli read deps-clip --json
```

**收益**：
- 编排 Prompt 体积减少 60%+，完全消除手写 SQL 与路径拼接出错风险；
- 支持通过 `ag-cli wait --children any` 同时并发跑 3 个仓库并按完成顺序逐个发布 Xray 报告；
- `deps-fix-orchestrator` 的 telemetry 指标（`inputTokens`、`cacheReadTokens`、`outputTokens`、`stepCount`）由 `ag-cli read --json` 原生直接返回。

---

### 2.3 工作流三：`hc` 与 `ag-cli` 双向异步唤醒网格（Reactive Mesh）

当一个复杂工程同时横跨 **终端智能体（`pi` / Codex in `hc`）** 与 **Antigravity 智能体（in `ag-cli`）** 时，双方通过统一的地址环境变量与回调信封互通，全程零轮询：

```text
[Antigravity 主控 c1]
    │
    ├──► `hc run --bg --name coder ...`
    │       (提示词要求完成后通知: ag-cli send c1 "coding done")
    │
    ├──► `ag-cli run --bg --name doc-check ...`
    │       (自动携带 <ag-cli from="c1" reach="ag-cli send c1 ...">)
    │
    └──► `ag-cli wait --children any` 或 `schedule(TimerCondition="any")`
            │
            ├── 当 [hc coder] 完活执行 `ag-cli send c1 "..."` ──► 立即触发 Antigravity c1 Reactive Wakeup
            └── 当 [ag-cli doc-check] 完活执行 `ag-cli send c1 "..."` ──► 同样立即触发 c1 Reactive Wakeup
```

双向组合后，本机上**任何 CLI 工具（`pi`、Claude Code、Codex、Shell 脚本、Cron Job）与 Antigravity 之间都不存在单向壁垒**，均可通过标准命令互相派活、等待与唤醒。
