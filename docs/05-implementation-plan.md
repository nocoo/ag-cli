# 05 · 工程结构、测试隔离与分期计划

> 状态：`v0.2-locked`（2026-11-14 · 已锁定 System0 12 槽位与 TDD/DDD 规程）
> 索引：[docs/README.md](./README.md)
> 前置文档：[01-overview-and-architecture.md](./01-overview-and-architecture.md) · [02-cli-and-protocol.md](./02-cli-and-protocol.md) · [03-state-and-storage.md](./03-state-and-storage.md) · [04-skill-and-workflows.md](./04-skill-and-workflows.md)

---

## 1. 仓库工程结构设计（已锁定技术栈 TypeScript + Bun）

遵循“核心决策逻辑与 I/O 分离”、“高内聚单文件控制在 ~32 KB 以内”的工程规范：

```text
team-gravity/
├── .github/
│   └── workflows/
│       └── ci.yml                       # 调用 nocoo/base-ci/.github/workflows/quality.yml@777bbe4...
├── docs/                                # 编号设计与架构文档（唯一行为真值来源）
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
│   ├── domain/                          # 纯逻辑层（零文件系统/进程依赖，L1 单元覆盖率 >= 95%）
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
│   ├── helpers/                         # 沙箱隔离夹具、Mock HTTP Daemon 与 Mock agentapi 替身
│   ├── unit/                            # L1 单元测试（纯领域逻辑 + CLI/Infra 单模块，>= 95% 覆盖率）
│   ├── integration/                     # L3 集成测试（真实 SQLite + FSWatcher + 本地 HTTP Mock）
│   └── e2e/                             # L4 端到端测试（真实 CLI 构建产物子进程全链路）
├── scripts/
│   ├── check-package.ts                 # P1 包产物检查脚本（npm pack 检查 bin 与安装可运行性）
│   └── hooks/                           # Git hooks（pre-commit / pre-push）与安装脚本
├── package.json                         # name: "team-gravity", bin: { "tg", "team-gravity" }
├── tsconfig.json                        # strict: true
├── biome.json                           # 零警告规范
├── vitest.config.ts                     # L1 覆盖率 95% 门槛与 L3/L4 分层配置
└── AGENTS.md                            # 项目级机器规范与 System0 质量合同
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

### 2.2 System0 12 槽位质量矩阵（对齐 `system0-quality` v1.3.0 与 `base-ci` v2026.15）

项目严格实现 System0 规范定义的全部 12 个标准槽位，并通过 `.github/workflows/ci.yml` 调用 `nocoo/base-ci/.github/workflows/quality.yml@777bbe4f9bacab8a91d8c01974480a6ee23d28e0` 进行集中仲裁：

| 槽位 | Canonical Name | 状态 | 命令 / 工具与本地 & CI 落地 | `base-ci` 输入 / 说明 |
| --- | --- | --- | --- | --- |
| **S1** | `S1: Types` | `impl` | `bun run typecheck`（`tsc --noEmit`，零容忍类型错误） | `typecheck: true` |
| **S2** | `S2: Lint` | `impl` | `bun run lint`（`biome check --error-on-warnings .`，零警告） | `lint: true` |
| **S3** | `S3: Workflow` | `impl` | `actionlint` + `yamllint` + 不可变 40 位 SHA Pin 检查 | `workflow-lint: true` |
| **G1** | `G1: Secrets` | `impl` | `gitleaks`（`pre-commit` 扫 staged，`pre-push` 扫提交区间，CI 扫全仓） | `security: true` |
| **G2** | `G2: Dependencies` | `impl` | `osv-scanner scan --lockfile=bun.lock` + `bun.lock` 镜像源纯度校验（`rg -c '", "https' bun.lock` 必须为 `0`） | `security: true`, `lockfiles: "bun.lock"` |
| **B1** | `B1: Build` | `impl` | `bun run build`（生成 NPM 入口产物 `dist/index.js` 与单二进制产物 `dist/tg`） | `build: true`, `build-command: "bun run build"` |
| **L1** | `L1: Unit` | `impl` | `bun run test:coverage`（`vitest run --coverage` 覆盖 `tests/unit/**/*.test.ts`，强制 statements/branches/functions/lines 四项均 `>= 95%`，同时禁止 `.only` / `.skip`） | `unit: true`, `test-command: "bun run test:coverage"` |
| **L2** | `L2: Runtime` | `na` | 本地 macOS CLI 包装层，无 Cloudflare Worker / `workerd` / 平台绑定运行时 | `l2-runtime: false`（`slot-status` 显式声明 `na` 及原因） |
| **L3** | `L3: Integration` | `impl` | `bun run test:integration`（`vitest run tests/integration`：真实临时 SQLite `conversation_summaries.db` + `state.db`、随机端口本地 `Bun.serve` HTTP Mock `language_server`、真实 `fs.watch` 增量读取 `transcript.jsonl`） | `l3-integration: true`, `l2-command: "bun run test:integration"` |
| **L4** | `L4: E2E` | `impl` | `bun run test:e2e`（`vitest run tests/e2e`：拉起构建后的 `tg` CLI 子进程，完整覆盖 `status`/`run --bg`/`run --reuse`/`send`/`wait`（含 Watermark 竞态与超时 `124`）/`read`/`ls`/`get`/`label`/`kill`/`rm`/`templates`/`events`/`--skill`/`schema`，无浏览器依赖） | `l4: true`, `l4-command: "bun run test:e2e"`（不设置 `l4-browsers`） |
| **P1** | `P1: Package` | `impl` | `bun run ci:package`（执行 `npm pack` 检查 tarball 打包文件列表、校验 `bin` 入口 `tg` / `team-gravity`、在隔离临时目录安装 tarball 做可运行性冒烟测试） | `package-check: true`, `package-command: "bun run ci:package"` |
| **Z1** | `Z1: Gate` | `impl` | `base-ci/quality.yml` 强制校验 12 键 `slot-status` JSON 与全部 Job `tested-sha` 一致 | 缺失任意槽位或结果不匹配即失败 |

`ci.yml` 中 `slot-status` 声明基线：

```json
{
  "S1": { "status": "impl" },
  "S2": { "status": "impl" },
  "S3": { "status": "impl" },
  "G1": { "status": "impl" },
  "G2": { "status": "impl" },
  "B1": { "status": "impl" },
  "L1": { "status": "impl" },
  "L2": { "status": "na", "reason": "Local macOS CLI wrapper without Cloudflare Worker or platform runtime bindings" },
  "L3": { "status": "impl" },
  "L4": { "status": "impl" },
  "P1": { "status": "impl" },
  "Z1": { "status": "impl" }
}
```

### 2.3 本地 Git Hooks 与 CI 三层门禁设计

| 防线层级 | 触发时机 | 执行机制与覆盖槽位 | 耗时目标 |
| --- | --- | --- | --- |
| **第一层：`pre-commit`** | 每次 `git commit` | 通过 `git worktree add` 对**当前 Git 暂存区索引快照**独立检查（屏蔽未暂存脏改动）：`G1`（staged secrets）+ 禁止 `.only`/`.skip` + `S1`（`typecheck`）+ `S2`（`lint`）+ `bun.lock` 镜像来源校验 + `L1`（`test:coverage >= 95%`） | `< 30s` |
| **第二层：`pre-push`** | 每次 `git push` | 逐行读取 `stdin` 提交的 `<local_ref> <local_oid> <remote_ref> <remote_oid>` 范围：`G1`（提交历史区间泄漏扫描）+ `G2`（`osv-scanner --lockfile=bun.lock`）+ `B1`（`build`）+ `L3`（`test:integration`）+ `L4`（`test:e2e`）+ `P1`（`ci:package`） | `< 2.5m` |
| **第三层：GitHub CI** | PR 与 `main` 推送 | 调用 `nocoo/base-ci/.github/workflows/quality.yml@777bbe4f9bacab8a91d8c01974480a6ee23d28e0`，并行运行 `S1`–`P1` 全部已启用槽位并由 `Z1: Gate` 校验 12 槽状态与统一 SHA | `< 5m` |

---

## 3. 严格 TDD 与文档驱动开发（DDD）工作流与分期计划

### 3.1 文档驱动开发（DDD）与严格 TDD 循环

1. **文档先行（Document-First Truth Source）**：
   - `docs/01`–`05` 是命令签名、JSON 字段、退出码、状态真值表与错误码的唯一真值来源。
   - **禁止先改行为后补文档**：若实现中发现需调整命令参数、输出结构或边界条件，必须先更新对应 `docs/*.md` 并原子提交（或与实现规范前置同步），再按更新后的契约编写测试。
2. **严格 TDD 红-绿-重构-门禁循环（Red → Green → Refactor → Gate）**：
   - **Red（先写失败测试）**：按当前 Step 对应的 `docs/` 契约先编写 `tests/unit`（必要时补充 `tests/integration` / `tests/e2e`），运行测试**亲眼确认因未实现或契约缺失而失败**。
   - **Green（最小实现通过）**：只编写足以让失败测试变绿的最小生产代码，不做未在文档与测试中声明的投机性抽象或冗余参数。
   - **Refactor（结构收口）**：在测试全绿保护下消除重复逻辑、保持函数短小单一职责，并确保新增公开函数与模块职责清晰。
   - **Gate（门禁全检）**：跑通 `S1`（`typecheck`）、`S2`（`lint`）、`L1`（`test:coverage >= 95%`）及当前阶段对应的 `L3`/`L4`/`B1`/`P1`，验证无误后立即执行主分支原子 commit。

### 3.2 主分支原子化提交纪律

- **主分支直推演进**：全程直接在 `main` 主分支开发与迭代，不拉冗余 feature 分支。
- **单逻辑单元原子提交**：每完成一个独立可验证的逻辑单元并走完 TDD 闭环与门禁后，立即执行原子化 commit。
- **精确暂存与格式规范**：严格使用 Conventional Commits（小写祈使句、`<= 50` 字符）；始终显式 `git add <具体文件>`，禁止 `git add .` 或 `git add -A`；除非哥明确要求，否则不主动执行 `git push`。

### 3.3 Phase 0 – Phase 4 严格 TDD 实施序列

每个 Step 均强制遵循 `Docs 核对 → Failing Test (Red) → Minimal Impl (Green) → Coverage/Lint Gate → Atomic Commit`：

| 阶段 | Step | TDD 先行测试与交付内容 | 验证门槛 | 预期原子 Commit Message |
| --- | --- | --- | --- | --- |
| **Phase 0** | 0.1 | 配置 `package.json`（镜像依赖，锁 `bun.lock`）、`tsconfig.json`、`biome.json`、`vitest.config.ts`、`AGENTS.md`、`scripts/check-package.ts`、`scripts/hooks/*` 与 `.github/workflows/ci.yml` | `S1`+`S2`+`G2`+`S3` 基础可运行 | `chore: initialize toolchain, base-ci and quality hooks` |
| **Phase 0** | 0.2 | 先写 `paths` 解析与沙箱环境隔离失败测试 → 实现 `src/infra/paths.ts`、`src/types/protocol.ts` 与 `tests/helpers/` 沙箱夹具 | `S1`+`S2`+`L1 (>=95%)` | `feat(infra): add path resolver and test harness` |
| **Phase 1** | 1.1 | 先写 `DaemonDiscovery` 单测与本地 Mock HTTP 集成测试 → 实现扫描 `hub_*.json`、PID 校验与 `/healthz` 探测 | `S1`+`S2`+`L1 (>=95%)`+`L3` | `feat(infra): add antigravity daemon discovery` |
| **Phase 1** | 1.2 | 先写 `SummariesReader`、`TranscriptParser` 边界用例单测（截断恢复、`transcript_full.jsonl` 回退）→ 实现只读读取器 | `S1`+`S2`+`L1 (>=95%)`+`L3` | `feat(domain): add summaries and transcript readers` |
| **Phase 1** | 1.3 | 先写 `TargetResolver` 优先级冲突单测与 `StateMachine` 五态全真值表测试 → 实现纯领域逻辑 | `S1`+`S2`+`L1 (>=95%)` | `feat(domain): add target resolver and state machine` |
| **Phase 1** | 1.4 | 先写 `status`/`ls`/`get`/`read`（TTY vs Piped JSON、`--steps`/`--full`/`--artifact`）单测与 E2E 测试 → 实现只读命令 | `S1`+`S2`+`L1 (>=95%)`+`L3`+`L4` | `feat(cli): add read-only status ls get read commands` |
| **Phase 2** | 2.1 | 先写 `TgStateStore` WAL 初始化、短 ID 分配、别名唯一约束与标签覆盖单测/集成测试 → 实现 `state.db` | `S1`+`S2`+`L1 (>=95%)`+`L3` | `feat(infra): add local tg state store` |
| **Phase 2** | 2.2 | 先写 `AgentApiClient`（Mock `agentapi` + HTTP `ReadProject`/`CancelCascadeInvocation`）与 `EnvelopeInjector` 测试 → 实现通信层 | `S1`+`S2`+`L1 (>=95%)`+`L3` | `feat(infra): add agentapi client and envelope injector` |
| **Phase 2** | 2.3 | 先写 `run --bg`（含 `--reuse` 幂等复用）、`send`（含 `--if`/`blocked`）、`label`/`interrupt`/`kill`/`rm` 测试 → 实现控制命令 | `S1`+`S2`+`L1 (>=95%)`+`L4` | `feat(cli): add run send label control commands` |
| **Phase 3** | 3.1 | 先写 Turn Watermark 竞态重现单测与 `TranscriptWatcher`（`fs.watch` + 增量 byte offset + 20ms 防抖 + 2s 兜底）集成测试 → 实现监听引擎 | `S1`+`S2`+`L1 (>=95%)`+`L3` | `feat(infra): add fs-watch transcript engine` |
| **Phase 3** | 3.2 | 先写 `wait`（`--children any|all` 与退出码 `124`）、同步 `run`、`send --wait`、`events` NDJSON E2E 用例 → 实现等待与事件流 | `S1`+`S2`+`L1 (>=95%)`+`L4` | `feat(cli): add event-driven wait and events commands` |
| **Phase 4** | 4.1 | 先写 `TemplateParser`、`templates`/`--skill`/`schema` 与 tarball 包验证测试 → 实现全部收尾并验证 `B1`+`P1` 全绿 | `S1`–`Z1` 全 12 槽本地可验证项全绿 | `feat(cli): add templates skill schema and e2e suite` |

---

## 4. 已锁定设计决策表（D1–D6）

以下 6 项核心决策已全部确认并锁定，后续实现严格照此执行：

| 编号 | 议题 | 已锁定决议 | 对应文档章节 |
| --- | --- | --- | --- |
| **D1** | **实现语言与运行时** | **TypeScript + Bun**（支持 NPM 分发 `bin` 与单二进制 `bun build --compile`） | [01 · §5 ADR-01](./01-overview-and-architecture.md) |
| **D2** | **包名与 CLI 命令短名** | NPM 包名锁定 **`team-gravity`**（`@nocoo/team-gravity` 亦空闲可用）；CLI 主命令 **`tg`** + 全称别名 **`team-gravity`** | [02 · §1.2](./02-cli-and-protocol.md) |
| **D3** | **`tg rm` / `tg kill` 清理边界** | **安全软管理**：默认仅更新/移除 `tg` 自有 `state.db` 记录，不删宿主机 `/brain/` 与原始 `.db`；仅 `--purge-brain` 删除产物目录 | [02 · §3](./02-cli-and-protocol.md) |
| **D4** | **协同信封注入策略** | **默认注入精简 `<tg from="..." reach="...">` 尾注**，提供 `--no-notify` 与 `--raw` 按需禁用 | [02 · §4](./02-cli-and-protocol.md) |
| **D5** | **System0 质量槽位配置** | 实现 `S1`、`S2`、`S3`、`G1`、`G2`、`B1`、`L1`（>=95%）、`L3`（Integration）、`L4`（CLI E2E）、`P1`（Package）、`Z1`（Gate）；仅 **`L2: Runtime`** 显式声明 `na` | [05 · §2.2–2.3](./05-implementation-plan.md) |
| **D6** | **工程研发流程** | **严格 TDD（Red → Green → Refactor → Gate）+ 文档驱动开发（DDD）+ 主分支原子提交** | [05 · §3](./05-implementation-plan.md) |
