# 05 · 工程结构、测试隔离与分期计划

> 状态：`v0.1-plan`（2026-11-14 · 待 Review）
> 索引：[docs/README.md](./README.md)
> 前置文档：[01-overview-and-architecture.md](./01-overview-and-architecture.md) · [02-cli-and-protocol.md](./02-cli-and-protocol.md) · [03-state-and-storage.md](./03-state-and-storage.md) · [04-skill-and-workflows.md](./04-skill-and-workflows.md)

---

## 1. 仓库工程结构设计（基于首选技术栈 TypeScript + Bun）

遵循"核心决策逻辑与 I/O 分离"、"高内聚单文件控制在 ~32 KB 以内"的工程规范：

```text
team-gravity/
├── docs/                                # 编号设计与架构文档（本阶段产物）
│   ├── README.md
│   ├── 01-overview-and-architecture.md
│   ├── 02-cli-and-protocol.md
│   ├── 03-state-and-storage.md
│   ├── 04-skill-and-workflows.md
│   └── 05-implementation-plan.md
├── src/
│   ├── cli/
│   │   ├── index.ts                     # CLI 入口、参数解析、错误捕获与退出码映射
│   │   ├── format.ts                    # TTY 表格/文本格式化 vs Piped/JSON 输出路由
│   │   ├── schema.ts                    # `tg schema` JSON Schema 生成与导出
│   │   ├── skill.md                     # 嵌入二进制的 `tg --skill` 手册原文
│   │   └── commands/                    # 每个动词一个独立单职责命令文件
│   │       ├── run.ts
│   │       ├── send.ts
│   │       ├── wait.ts
│   │       ├── read.ts
│   │       ├── ls.ts
│   │       ├── get.ts
│   │       ├── label.ts
│   │       ├── control.ts               # interrupt / kill / rm
│   │       ├── templates.ts
│   │       ├── events.ts
│   │       └── status.ts
│   ├── domain/                          # 纯逻辑层（零文件系统/进程依赖，单元测试毫秒级跑完）
│   │   ├── state-machine.ts             # 五态推导真值表 & Watermark 判定纯函数
│   │   ├── target-resolver.ts           # name / cN / uuid-prefix / uuid 解析规则
│   │   ├── transcript-parser.ts         # JSONL 行解析、Turn 切分、Telemetry 聚合
│   │   ├── envelope.ts                  # <tg from="..." reach="..."> 信封构造与识别
│   │   └── template-parser.ts           # Frontmatter + Body 解析与模型/工作区合并
│   ├── infra/                           # 宿主机 I/O 适配层（全部支持 env path 注入隔离）
│   │   ├── paths.ts                     # TG_HOME / TG_CONFIG_DIR / TG_ANTIGRAVITY_DIR 解析
│   │   ├── daemon-discovery.ts          # 扫描 daemon/hub_*.json、校验 PID 与端口健康
│   │   ├── agentapi-client.ts           # 封装 agentapi CLI 调用及 HTTP Connect RPC 补位
│   │   ├── summaries-reader.ts          # 只读查询 conversation_summaries.db
│   │   ├── transcript-watcher.ts        # fs.watch + byte offset 增量读取 + 兜底校验
│   │   └── state-store.ts               # ~/.local/share/team-gravity/state.db 读写
│   └── types/
│       └── protocol.ts                  # 对外暴露的稳定 JSON 类型与错误枚举定义
├── tests/
│   ├── unit/                            # 纯领域逻辑测试（state-machine, parser, resolver, envelope）
│   ├── integration/                     # 沙箱 SQLite + FSWatcher + Mock Daemon 集成测试
│   └── e2e/                             # 编译/CLI 子进程端到端行为验证
├── scripts/
│   └── hooks/                           # pre-commit / pre-push 质量门禁脚本
├── package.json
├── tsconfig.json
├── biome.json
└── AGENTS.md                            # 项目级机器规范与质量合同（后续 Phase 0 落地）
```

---

## 2. 质量体系与测试隔离策略（对齐 `system0-quality`）

### 2.1 硬性沙箱隔离铁律（参考 `herdr-core` `AGENTS.md`）
- **任何自动化测试（Unit / Integration / E2E）绝对禁止读写宿主机真实的 `~/.gemini/antigravity`、`~/.local/share/team-gravity` 以及正在运行的 Antigravity 会话！**
- 所有测试夹具（Harness）必须在系统临时目录（如 `/tmp/tg-test-<uuid>`）创建隔离环境，并显式注入三组路径环境变量：
  - `TG_HOME=<tmp>/tg-home`
  - `TG_CONFIG_DIR=<tmp>/tg-config`
  - `TG_ANTIGRAVITY_DIR=<tmp>/antigravity`
- 在隔离目录中布置：
  - **Mock Daemon Discovery**：写入临时 `daemon/hub_<port>.json`，配合测试内启动的随机空闲端口本地 `Bun.serve` HTTP Mock 服务（响应 `/healthz`、`ReadProjects`、`CancelCascadeInvocation`）。
  - **Mock `agentapi` 可执行替身**（通过 `TG_AGENTAPI_BIN` 注入）：模拟 `new-conversation` / `send-message` / `get-conversation-metadata`，将真实落盘行为（向临时 `conversation_summaries.db` 写行 + 异步分步向 `brain/<id>/.system_generated/logs/transcript.jsonl` 追写 step）还原出来，从而**无费用、确定性地真实压测 Turn Watermark 竞态与 FSWatcher 等待逻辑**。

### 2.2 质量门禁映射（`base-ci` / `system0-quality`）

| 槽位 | 检查内容 | 本地/CI 落地 |
| --- | --- | --- |
| **S1 / S2** | TypeScript 类型检查 + Biome 静态代码检查 | `bun run typecheck` / `bun run lint`（零警告） |
| **L1** | `tests/unit` + `tests/integration` 单元测试与覆盖率门禁 | `bun test --coverage`（在 `pre-commit` 索引快照中执行，`< 30s`） |
| **L2** | `tests/e2e` 真实 CLI 子进程 + Mock HTTP/SQLite/FSWatcher 端到端测试 | `bun run test:e2e`（含 `tg run --reuse`、Watermark 竞态、超时 `124`、管道 JSON） |
| **G1 / G2** | 密钥泄漏与依赖漏洞扫描 | `gitleaks` + `osv-scanner`（`pre-push` 与 CI 强门禁） |
| **B1** | 单二进制构建产物验证 | `bun build --compile src/cli/index.ts --outfile dist/tg` |

---

## 3. 分阶段实施计划与原子提交规划（Phase 0 – Phase 4）

### 3.1 主分支原子化提交纪律

- **主分支直推演进**：全程直接在 `main` 主分支开发与迭代，不拉冗余 feature 分支。
- **单逻辑单元原子提交**：每完成一个独立可验证的逻辑单元，必须在跑通当前类型检查、lint 与相关测试后立即执行原子化 commit。
- **精确暂存与格式规范**：严格使用 Conventional Commits（小写祈使句、`<= 50` 字符）；始终显式 `git add <具体文件>`，禁止 `git add .` 或 `git add -A`；除非哥明确要求，否则不主动执行 `git push`。

### 3.2 阶段拆解与预期 Commit 序列

| 阶段 | Step | 交付内容与验证门槛 | 预期原子 Commit Message |
| --- | --- | --- | --- |
| **Phase 0** | 0.1 | 初始化 `package.json`、`tsconfig.json`、`biome.json`、`AGENTS.md` 与 `scripts/hooks`（`pre-commit`/`pre-push`） | `chore: initialize project toolchain and quality hooks` |
| **Phase 0** | 0.2 | 实现 `src/infra/paths.ts`、协议类型 `src/types/protocol.ts` 与测试沙箱 Harness 骨架，验证 `lint`+`typecheck`+`test` 全绿 | `feat(infra): add path resolver and test harness` |
| **Phase 1** | 1.1 | 实现 `DaemonDiscovery`（扫描 `hub_*.json`、校验 PID 与 `/healthz`）及单元测试 | `feat(infra): add antigravity daemon discovery` |
| **Phase 1** | 1.2 | 实现只读 `SummariesReader`、`TranscriptParser`（`transcript.jsonl`/`transcript_full.jsonl`）及解析单测 | `feat(domain): add summaries and transcript readers` |
| **Phase 1** | 1.3 | 实现 `TargetResolver`、`StateMachine`（五态推导纯函数）及真值表全覆盖测试 | `feat(domain): add target resolver and state machine` |
| **Phase 1** | 1.4 | 落地 `tg status`、`tg ls`、`tg get`、`tg read`（含 `--steps`/`--full`/`--artifact`/`--json`）及集成测试 | `feat(cli): add read-only status ls get read commands` |
| **Phase 2** | 2.1 | 实现 `TgStateStore`（`state.db` 初始化、短 ID 分配、别名唯一性与标签 CRUD）及存储测试 | `feat(infra): add local tg state store` |
| **Phase 2** | 2.2 | 实现 `AgentApiClient`（零配置环境注入、`projectId` 自动匹配、`CancelCascadeInvocation` HTTP 补位）与 `EnvelopeInjector` | `feat(infra): add agentapi client and envelope injector` |
| **Phase 2** | 2.3 | 落地 `tg run --bg`（含 `--reuse`）、`tg send`（含 `--if` 与 `blocked` 拦截）、`tg label`、`tg interrupt`、`tg kill`、`tg rm` | `feat(cli): add run send label control commands` |
| **Phase 3** | 3.1 | 实现 `TranscriptWatcher`（`fs.watch` + 增量 byte offset + 20ms 防抖 + 2s 兜底校验）与 Turn Watermark 闭环验证 | `feat(infra): add fs-watch transcript engine` |
| **Phase 3** | 3.2 | 落地 `tg wait`（含 `--children any|all` 与退出码 `124`）、同步 `tg run`、`tg send --wait`、`tg events`（NDJSON 流） | `feat(cli): add event-driven wait and events commands` |
| **Phase 4** | 4.1 | 实现 `TemplateParser`、`tg templates`、`tg --skill` 与 `tg schema` 导出，补齐全链路 E2E 测试与单二进制构建 | `feat(cli): add templates skill schema and e2e suite` |

---

## 4. 待哥 Review 拍板的设计决策表

在进入 Phase 0 编码前，请哥确认以下 4 项关键决策（已按推荐项撰写上述文档，若有调整只需改对应章节）：

| 编号 | 议题 | 推荐方案 | 备选方案 | 影响面 |
| --- | --- | --- | --- | --- |
| **D1** | **实现语言与运行时** | **TypeScript + Bun**（编译为单二进制 `tg`） | Rust（与 `herdr-core` 同构） | 技术栈、仓库依赖、CI 槽位与 JSONL 迭代效率 |
| **D2** | **CLI 命令短名** | **`tg`**（对应 `team-gravity`） | `ag` / `antigravity-tg` / `gravity` | 日常敲击长度与所有 Skill/模板中的调用命令 |
| **D3** | **`tg rm` / `tg kill` 清理边界** | **安全软管理**：默认仅标记/移除 `tg` 自有 `state.db` 记录，不触碰宿主机 `/brain/` 与 `.db` 原始数据；仅 `--purge-brain` 删除产物目录 | 调用后同时物理清理 Antigravity 原始记录与数据库 | 防止误操作销毁用户在 Antigravity UI 中的历史对话与报告 |
| **D4** | **协同信封注入策略** | **默认开启精简 `<tg from="..." reach="...">` 尾注**，提供 `--no-notify` 或 `--raw` 禁用 | 默认发送裸文本，需显式传 `--envelope` 才附加 | 外部 Bot 与主控能否开箱即用实现双向异步唤醒 |
