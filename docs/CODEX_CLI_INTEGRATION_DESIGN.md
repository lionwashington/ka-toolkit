# Codex CLI 集成设计

> 状态：拟定的实施基线（2026-07-19）
>
> 范围：在保持 Claude Code 现有行为兼容的前提下，将 Codex 增加为 KA 的一等运行时。本文严格按 KA 的四个功能部分——Channel、Workshop、KB、Cron——分别描述，避免把通信、编排、知识能力和调度混成一个子系统。

## 1. 目标与边界

KA 是一个由可替换 Agent 运行时承载的、本地优先的个人知识助理工具集。目前唯一完整实现的运行时是 Claude Code。本次工作要增加 Codex 支持，同时保持以下原则：

- KB 和个人 Agent workspace 继续由用户本地拥有；
- Telegram/Lark 凭据只留在 Channel daemon；
- 设计态源码与 `$KA_HOME` 运行态产物继续分离；
- Claude Code 与 Codex 可以并存；
- 四个功能部分只通过明确接口协作，不反向侵入彼此职责。

首个完整里程碑包括：

- Channel：Telegram/Lark 与 Codex thread 双向通信；
- Workshop：启动和管理 Codex mate，并支持 Claude/Codex 混合 workshop；
- KB：捕获 Codex 对话，并能用 Codex 执行 distill；
- Cron：无需依赖某个在线 TUI，按计划触发 KB、Channel 等命令；
- Codex 会话、KA binding 和 distill watermark 均可跨进程重启恢复。

初始版本不远程复刻完整 Codex TUI，不提供多人授权系统，不保证多个 Codex surface 同时向同一个 active turn 输入，也不增加 Gemini CLI。

## 2. 总览：Codex App Server 是什么

### 2.1 它与 KA Channel daemon 不是一回事

系统中会有两个职责不同的后台进程：

```text
KA Channel daemon                      Codex App Server
-----------------                      ----------------
属于 KA                                属于 Codex
懂 Telegram/Lark                       懂 thread/turn/item
持有消息平台凭据                       使用 Codex 本地登录状态
负责鉴权、路由、去重、投递             负责执行 Agent 工作
保存 channel binding                   保存和恢复 Codex 会话
把 runtime 输出送回消息平台             产生结构化执行事件
```

Codex App Server 可以理解为“没有固定界面的 Codex Agent 引擎”。Codex TUI、IDE 扩展或 KA Channel daemon 都可以成为它的 client。它不是 Telegram/Lark bot，不能替代 Channel daemon。

它虽然叫 Server，第一版却不监听公网或 TCP 端口。Channel daemon 启动一个独立的 `codex app-server` 子进程，通过 stdin/stdout 上的 JSONL 双向通信。

```text
Channel daemon 进程
       |
       | stdin/stdout JSON-RPC
       v
codex app-server 进程
       |- thread: main
       |- thread: reviewer
       `- thread: helper
```

### 2.2 TUI、App Server 与 `codex exec`

TUI 是 Terminal User Interface，即直接运行 `codex` 后看到的终端交互界面。

```text
同一个 codex 程序
|- codex                 -> 面向人的交互式 TUI
|- codex exec            -> 执行一次任务后退出
`- codex app-server      -> 面向其他程序的无固定界面 Agent 后端
```

第一版 Codex Channel 使用 App Server，所以 Telegram/Lark 后面不需要再运行一个 Codex TUI。Codex 仍会执行工具、修改文件并保存会话，只是没有一个本地终端界面。

`codex exec --json` 用于 KB distill 等独立的一次性后台任务，也可作为 Channel 的兼容性降级路径；它不是 Channel 的主要通信架构。

### 2.3 App Server 的主要概念

- **Thread**：一段可持续多轮的 Codex 对话，约等于 Claude Code session。
- **Turn**：thread 中的一次用户请求及其完整执行过程。
- **Item**：turn 中的结构化步骤，例如文字、命令、文件修改、MCP 调用。
- **Event**：App Server 向 client 汇报的 `turn/started`、message delta、`item/completed`、`turn/completed` 等消息。
- **Approval**：Codex 请求执行高风险操作时，由 App Server 发给 client 的审批请求。

`turn/start` 可以类比为“向一个现有 Agent 会话输入消息并按下 Enter”，但它是结构化 API，不需要操作终端键盘。`turn/interrupt` 类似在 TUI 中按 Esc。

### 2.4 本地会话持久化

正常 Channel thread 必须持久化，不得设置 `ephemeral: true`。Codex 默认保存到：

```text
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl
```

未设置 `CODEX_HOME` 时即：

```text
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl
```

归档会话和部分索引状态分别位于：

```text
$CODEX_HOME/archived_sessions/
$CODEX_HOME/sqlite/
```

Codex 不使用 Claude 的 `~/.claude/projects/<encoded-cwd>` 目录模型。实现必须使用 App Server 返回的 `threadId` 和 `thread.path`，不能根据 cwd 猜测文件路径。

## 3. Part 1 — Channel：Telegram/Lark 与运行时通信

### 3.1 职责

Channel 只负责通信：

- Telegram/Lark 收发；
- 用户和 chat allowlist；
- `to <name>:` 等路由；
- 外部 chat/thread 与 runtime session/thread 的绑定；
- 消息去重、队列、重试和流式展示；
- Claude/Codex mate 之间的消息传递；
- 将 runtime approval 转换为消息平台按钮或卡片。

Channel 不负责 KB distill，不负责 Cron 调度，也不负责 tmux 布局。

### 3.2 现有 Platform 接口不是新增部署层

文中的 Platform 指仓库已经存在的进程内逻辑接口：

- `channels/core/src/platform.ts`；
- `channels/telegram/telegram-platform.ts`；
- `channels/lark/lark-platform.ts`。

daemon 启动时选择 Telegram 或 Lark 实现，并与 `channels/core` 打包、运行在同一个 Channel daemon 进程内。不会新增独立的“平台适配器服务”。

```text
消息平台轴：Telegram Platform | Lark Platform   （现有，同进程插件）
运行时轴：  Claude Runtime    | Codex Runtime   （新增 Codex）
```

任意组合仍由一个 Channel daemon 协调，例如 Telegram + Claude、Telegram + Codex、Lark + Claude 或 Lark + Codex。

### 3.3 当前 Claude Code 链路

```text
Telegram/Lark 用户消息
       -> Channel daemon 根据 channel name 找在线 Claude consumer
       -> notifications/claude/channel
       -> Claude development-channel consumer
       -> Claude Code 处理
       -> Claude 调用 reply MCP tool
       -> Channel daemon 发回 Telegram/Lark
```

关键特征：Claude Code 主动连接 Channel daemon；daemon 向在线 Claude 进程推消息；Claude 用 `reply` 工具回消息。

### 3.4 Codex 链路

Codex 没有与 Claude development channel 完全等价的自定义 notification 注入机制，因此连接方向改变：Channel daemon 作为 client 主动控制 App Server。

```text
Telegram/Lark 用户消息
       -> Channel daemon 根据 binding 找到 Codex threadId
       -> thread/resume（必要时）
       -> turn/start
       -> Codex App Server 执行
       -> text/tool/file/approval/final event
       -> Channel daemon 渲染并发回 Telegram/Lark
```

| 问题 | Claude Code 当前方式 | Codex App Server 方式 |
|---|---|---|
| 谁主动建立 runtime 连接 | Claude 连接 Channel daemon | Workshop 启动 App Server；TUI 与 Channel 分别连接 |
| 如何输入消息 | MCP notification | `turn/start` JSON-RPC request |
| 如何返回结果 | Claude 调 `reply` MCP tool | App Server 发 item/turn event |
| runtime 身份 | 在线 Claude MCP session | 持久化 Codex `threadId` |
| 是否必须有 TUI | 当前实现需要 | 不需要，可 headless |
| 重启恢复 | SSE reconnect/re-adopt | binding + `thread/resume` |
| 对话落盘 | `~/.claude/projects` | `$CODEX_HOME/sessions` |

### 3.5 RuntimeChannel 接口

Channel 内部只抽象通信所需能力：

```ts
interface RuntimeChannel {
  kind: 'claude' | 'codex'
  connect(): Promise<void>
  health(): Promise<RuntimeHealth>
  createSession(input: CreateSessionInput): Promise<RuntimeBinding>
  resumeSession(binding: RuntimeBinding): Promise<void>
  sendMessage(binding: RuntimeBinding, message: RuntimeMessage): Promise<RuntimeTurn>
  interrupt(binding: RuntimeBinding): Promise<void>
  answerApproval(binding: RuntimeBinding, requestId: string, decision: ApprovalDecision): Promise<void>
  dispose(): Promise<void>
}
```

runtime event 在到达 Telegram/Lark 前规范化为 `turn-started`、`text-delta`、`activity`、`approval`、`final`、`error` 和 `turn-completed`。

Channel transport configuration does not declare runtime targets, and Channel
never reads `workshop.yaml`. Workshop starts one App Server sidecar for each
Codex mate, connects the TUI to the same per-mate loopback WebSocket, and registers the
live endpoint with Channel's loopback control API. The registration loop heals
a later Channel start or restart. On pane shutdown, Workshop unregisters the
target and terminates the App Server. Channel owns only routing clients and
never owns the App Server process.

### 3.6 持久化 binding

```ts
interface ChannelBinding {
  channelName: string
  platform: 'telegram' | 'lark'
  externalChatId: string
  externalThreadId?: string
  runtime: 'claude' | 'codex'
  runtimeSessionId: string // Codex 时为 threadId
  runtimeSessionPath?: string
  cwd: string
  activeTurnId?: string
  createdAt: string
  updatedAt: string
}
```

第一版用原子替换的 JSON 文件保存：

```text
$KA_HOME/channels/<kind>-daemon/bindings.json
```

KA 不复制完整 Codex transcript，只保存轻量 binding。删除 binding 不得删除 `$CODEX_HOME/sessions` 中的会话。

### 3.7 队列、输出和审批

- 每个 thread 使用串行 FIFO；active turn 期间的新普通消息排队。
- `/stop` 映射到 `turn/interrupt`；普通消息不隐式 `turn/steer`。
- 平台 event ID 用于有限窗口去重，防止重复 turn。
- Telegram 通过限频编辑消息实现 streaming；Lark 优先使用 CardKit。
- reasoning 默认不转发；命令、文件和 MCP event 转为简洁 activity。
- App Server 仅绑定 `ws://127.0.0.1:<ephemeral-port>`；不监听外部网卡。
- 默认 sandbox 不得为 `danger-full-access`。
- approval 必须绑定 channel、thread、turn、request ID，按钮单次使用并过期。
- 平台 token 永不传给 Codex。

### 3.8 Channel 验收

- Telegram 驱动持久化多轮 Codex thread；
- Channel daemon 和 App Server 重启后可继续；
- 两个 thread 可隔离并发；
- streaming、interrupt、基础 approval 和去重工作正常；
- 再复用同一 runtime bridge 接入 Lark。

## 4. Part 2 — Workshop：管理多个运行时

### 4.1 职责

Workshop 只负责运行时编排：

- 读取 `workshop.yaml`；
- 管理 mate 的 cwd、runtime 类型和生命周期；
- 为 Codex mate 启动和停止 App Server sidecar，并维护 Channel 注册；
- 管理 tmux pane/window 或 headless mate 的状态展示；
- 调用 Channel 提供的绑定能力，但不实现 Telegram/Lark 协议；
- 不执行 KB distill，也不拥有 Cron schedule。

### 4.2 配置

```yaml
session: workshop
runtime: codex

mates:
  - name: main
    runtime: codex
    cwd: ~/workspace/main
    main: true
    codex:
      profile: workshop
      sandbox: workspace-write

  - name: legacy
    runtime: cc
    cwd: ~/workspace/legacy

  - name: reviewer
    runtime: codex
    cwd: ~/workspace/reviewer
    default: false
    codex:
      profile: review
      sandbox: read-only
```

runtime-specific 配置放在 `codex:` 或 `claude:` 下；通用 `args` 不得混入语义冲突的 runtime flag。

The same Codex mate declarations are consumed by both Workshop orchestration and
the Channel App Server bridge. Telegram/Lark configuration remains transport-only.

### 4.3 Codex mate 形态

第一版 Codex mate 是持久化的 headless thread，不需要启动 Codex TUI。Workshop 可以显示轻量状态/log pane，但该 pane 不是 Codex 原生 TUI。

```text
一个 Channel daemon
  `- 一个 codex app-server 子进程
       |- main thread
       |- reviewer thread
       `- helper thread
```

现有 Claude mate 仍是一个独立 Claude OS 进程和 tmux pane。混合 workshop 中，两种形态可以并存。

### 4.4 Workshop runtime adapter

建议将现有 Claude-specific 启动逻辑收进 `workshop/ops/runtimes/cc.sh`，新增 `codex.sh`，分别负责：

- runtime availability；
- mate 启动/停止；
- session/thread identity；
- ready/health 状态；
- runtime-specific 配置映射。

Workshop 不应解析 App Server item event；那是 Channel runtime bridge 的职责。

### 4.5 Workshop 验收

- `runtime: cc|codex` 和逐 mate override 生效；
- Claude 与 Codex mate 使用隔离 cwd/session；
- `ka workshop`、`ka status`、`ka doctor` 正确显示两类 mate；
- Claude/Codex mate 可通过 Channel bus 互发任务。

## 5. Part 3 — KB：捕获、Distill、存储与检索

### 5.1 职责

KB 只负责能力和知识管线：

```text
runtime transcript
       -> capture
       -> raw/*.md
       -> distill
       -> topics/*.md + conversations/*.md
       -> reindex
       -> kb_search
```

KB 不负责 Telegram/Lark 收发，不依赖 Channel daemon 是否在线，也不管理 workshop pane。

### 5.2 现有 distill 的真实工作方式

现有管线不是一个普通 TypeScript 函数直接调用模型 API。核心语义写在 `kb/skills/kb.md` 中，由 Agent runtime 自己作为 LLM 阅读 raw、判断知识、更新 Markdown。

当前后台流程是：

```text
/kb distill 或 ka kb distill
       -> kb/ops/distill-bg.sh
       -> 创建 snapshot offset、状态文件和日志
       -> kb/ops/distill-bg-worker.sh
       -> 启动 headless Claude/Opus
       -> 执行 /kb distill --foreground 语义
       -> 更新 raw/topics/conversations
       -> 写 distill stats
       -> 增量 reindex
```

也就是说，当前后台 distill 仍然强绑定 Claude CLI；“KB 数据格式和流程 runtime-agnostic”不等于“distill executor 已经 runtime-agnostic”。Codex 支持必须补上这条缺口。

### 5.3 Capture

Codex 原始对话的事实来源是 `$CODEX_HOME/sessions` 下的 rollout。Codex adapter 通过 lifecycle hook 和/或 App Server event 将对话转换为现有 `raw/*.md` 格式。

Capture 使用：

```text
(runtime, threadId, turnId)
```

作为去重键，避免 hook 与 App Server 同时观察到一个 turn 时重复写入。

增量 capture 继续使用 offset/watermark，只读取 rollout 新增内容。新内容写入或追加到 raw 后：

```yaml
distilled: false
```

Codex rollout 是原始 transcript；`raw/*.md` 是供 distill 使用的规范化副本，两者职责不同。

### 5.4 Codex distill executor

KB 需要独立的 `DistillRuntime`/executor 边界：

```text
DistillRuntime
|- cc    -> 现有 headless Claude worker
`- codex -> codex exec --json 执行一次独立 distill 任务
```

第一版 Codex distill 推荐使用 `codex exec --json`，而不是复用 Channel daemon 管理的 App Server，原因是：

- KB 与 Channel 必须能独立运行；
- `ka kb distill` 在没有 Telegram/Lark daemon 时也必须可用；
- distill 是一次性后台 batch，不需要长期交互 thread；
- Cron 可以直接等待命令 exit code；
- 故障和日志更容易与用户对话 thread 隔离。

Codex distill task 可以使用临时执行上下文，但其输入和产物必须由 KA watermark 保证幂等。是否使用 Codex ephemeral session 不影响 KB 结果；建议 distill executor 使用 ephemeral，避免 `$CODEX_HOME/sessions` 被大量内部维护会话污染。正常用户 Channel thread 仍禁止 ephemeral。

配置建议：

```yaml
kb:
  distill:
    runtime: codex   # codex | cc
    profile: distill
```

未显式配置时，可跟随系统默认 runtime；但 installer/doctor 必须显示最终选择，不能静默切换模型运行时。

### 5.5 单次 distill 的阶段

#### Capture 当前增量

1. 确定目标 transcript/rollout 和本次 snapshot upper offset。
2. 根据 raw frontmatter 中的 parse watermark，只读取新 delta。
3. 追加规范化 Markdown，更新 offset/UUID watermark。
4. 保持 `distilled: false`。

snapshot upper offset 保证 distill 运行期间新产生的内容留给下一次，不会读取一个不断增长的文件。

#### Distill 当前 raw

1. 读取 `distilled: false` 的目标 raw。
2. 判断内容是噪声还是有知识价值。
3. 写入或更新 `topics/*.md`，可选更新 `conversations/*.md`。
4. 只追加真正的净新增知识，避免重复。
5. 将处理过的 raw 标为 `distilled: true`，并写入 `topics:` back-reference。

#### 有界 backlog drain

每次运行额外处理有限数量最旧的 `distilled: false` raw，用于修复过去失败留下的积压。必须设置上限，避免一次任务吞下整个历史库。

#### Stats、失败与重建索引

- worker 写 `distill-current.json` 和 per-run log；
- 失败写 `distill-last-failure.json`，不会持有 Telegram token；
- 成功后触发增量 `ka kb reindex`；
- retrieval daemon 暂时不可用时，reindex 失败不应让 distill 结果回滚，后续 daemon 启动可自愈。

### 5.6 Watermark 与幂等性

```text
rollout/jsonl
  -- last_parsed_offset --> raw/*.md
  -- distilled flag -----> topics/*.md + conversations/*.md
  -- source mtime -------> LanceDB index
```

- `last_parsed_offset`：不重复读取 transcript；
- `distilled`：不重复蒸馏 raw；
- `topics` back-reference：保留 raw 到知识主题的来源关系；
- index manifest/mtime：不重复重建未变化内容。

### 5.7 KB 安装面

Codex adapter 负责：

- 注册现有 KA MCP server；
- 部署 `$CODEX_HOME/skills/<name>/SKILL.md`；
- 在 `AGENTS.md` 中维护明确标记的 KA section；
- 安装 capture hook；
- 安装 Codex distill executor 配置。

installer 不覆盖无关用户配置。Claude 和 Codex 都指向 `$KA_HOME` 下的部署产物，而不是设计态仓库。

### 5.8 KB 验收

- 普通 Codex thread 被增量捕获到 raw，且每个 turn 只捕获一次；
- `ka kb distill` 可在 Channel daemon 未运行时通过 Codex 完成；
- raw 正确进入 topics/conversations，并写回 `distilled` 与 `topics`；
- 失败状态、backlog drain、统计和增量 reindex 保持现有语义；
- `kb_search` 能检索新蒸馏知识。

## 6. Part 4 — Cron：只负责何时触发

### 6.1 职责

Cron 只负责调度，不拥有具体业务实现：

```text
Cron --何时--> ka kb distill
Cron --何时--> ka channel start
Cron --何时--> ka kb start
Cron --何时--> daily brief command
```

它不理解 Codex thread/item，不处理 Telegram/Lark，不直接写 KB topic，也不管理 tmux pane。

### 6.2 Distill 调度方式

目标架构中，定时 distill 应直接执行：

```bash
ka kb distill --background
```

然后由 KB 自己根据 `kb.distill.runtime` 选择 Claude 或 Codex executor。

不建议继续把“向 main channel 注入 `/kb distill` prompt”作为主调度方式，因为这会让 KB maintenance 依赖一个在线 Channel session/TUI，并混淆 Cron、Channel、KB 三个部分。旧 `inject-prompt` job 可以作为迁移兼容路径，但新配置应使用直接命令。

### 6.3 状态与通知边界

- Cron 依据 exit code 记录 job 成败；
- KB worker 写 distill status/failure sentinel；
- Cron 和 KB worker都不持有 Telegram/Lark token；
- 如果需要通知用户，由主 Agent/Channel 读取未 ack 的 failure sentinel 后发送；
- 通知失败不改变 distill 本身的成功或失败状态。

### 6.4 Cron 验收

- Codex-only 环境中，定时 distill 不依赖 Claude 或在线 Channel；
- daemon keepalive 继续只调用 `ka channel start`/`ka kb start`；
- job 状态、日志和失败 sentinel 可被 `ka cron`、`ka kb distill status`、`ka doctor` 检查；
- 旧 inject-prompt 配置有明确迁移提示。

## 7. 四部分之间的接口

```text
                 +----------------------+
                 | Part 4: Cron         |
                 | 只触发 ka 命令       |
                 +----+-------------+---+
                      |             |
                      v             v
+---------------------+--+      +---+----------------+
| Part 3: KB             |      | Part 1: Channel    |
| capture/distill/search |      | Telegram/Lark 通信 |
+------------------------+      +---+----------------+
                                     ^
                                     |
                              +------+-------------+
                              | Part 2: Workshop   |
                              | runtime/mate 编排  |
                              +--------------------+
```

接口约束：

- Workshop 可请求 Channel 建立 mate binding，但不实现平台通信；
- Channel 可把 runtime 对话交给 KB capture，但不执行 distill；
- KB 可独立执行 distill，不依赖 Channel/Workshop 在线；
- Cron 只调用公开 `ka` 命令，不进入任何部分的内部状态机。

## 8. 建议源码布局

```text
channels/core/src/runtime/
  types.ts
  registry.ts
  claude.ts
  codex/
    client.ts
    protocol.ts
    adapter.ts
    event-normalizer.ts
    bindings.ts

workshop/ops/runtimes/
  cc.sh
  codex.sh

kb/
  adapter-cc/
  adapter-codex/
    src/install.ts
    src/capture.ts
    src/hooks/
  ops/distill-runtimes/
    cc.sh
    codex.sh
```

这是目标布局，不代表 Phase 0 获得大范围目录迁移授权。

## 9. 研发分支与变更门禁

正式研发已从经过验证的 `main` 基线创建专用分支 `feat/codex-runtime`。后续实现、测试和评审均在该分支按阶段推进：

```bash
git switch main
git status --short
git switch -c feat/codex-runtime
```

创建分支前必须满足：

- 当前 `main` 与预期基线一致；
- 工作区没有来源不明的修改；
- 现有测试基线已执行并记录结果；
- 设计文档已提交，或明确随 feature branch 的第一个 commit 一起提交。

不得在有未确认用户修改的 dirty worktree 中强行切分支。正式研发过程按可评审的阶段提交，不把协议 spike、基础重构和四个功能部分压成一个巨大 commit。

建议提交序列：

```text
docs: finalize codex runtime design
test: add runtime-boundary characterization coverage
refactor: extract runtime-neutral boundaries
feat(kb): add codex capture and distill executor
feat(channel): add codex app-server bridge
feat(workshop): add codex runtime mates
feat(cron): run distill through runtime-neutral command
```

## 10. 实施顺序

### Phase 0：建立分支与测试基线

状态（2026-07-19）：已完成。构建、monorepo 测试、Lark E2E 和 Docker E2E 均已通过；详细结果见 `CODEX_APP_SERVER_SPIKE.md`。

1. 创建 `feat/codex-runtime`（最终名称可在开工时确认）。
2. 运行现有单元、集成、Channel E2E 和 Docker E2E。
3. 记录已存在的失败、平台限制和耗时，不能把历史失败误判为本次回归。
4. 为即将移动的 Claude-specific 行为补 characterization test，尤其是：
   - Claude capture hook 输入/输出；
   - workshop runtime dispatch、ready detection 和 resume；
   - Channel session、dispatch、reply、re-adopt；
   - distill worker 的状态、watermark、failure sentinel；
   - Cron command dispatch。

退出条件：基线可重复，关键既有行为在重构前已有自动化保护。

### Phase 1：App Server 协议 spike

状态（2026-07-19）：已完成。真实 App Server 的持久化 thread、跨进程 resume、上下文连续性、双 thread 并发与 interrupt 均通过；fake server 覆盖畸形 event 和 supervisor 有界重启。可以进入 Phase 2。

构建隔离、可测试的 App Server client，验证：

- initialize/schema/capability；
- thread start/resume/list/read；
- turn streaming、interrupt 和 approval；
- 两个 cwd/thread 并发；
- 子进程死亡、畸形 event、timeout 和有界重启；
- 非 ephemeral thread 写入 `$CODEX_HOME/sessions` 并可跨进程恢复。

spike 使用隔离的临时 `CODEX_HOME`、workspace 和测试 binding，不连接生产 Telegram/Lark，不改写用户正常 Codex session。若协议验证失败，应先修订设计，不进入基础重构。

### Phase 2：运行时边界重构

Status (2026-07-19): complete. Workshop and distill now dispatch through explicit
runtime adapters. Channel routing now uses a runtime-neutral target registry while
preserving the existing Claude MCP session FIFO, probes, and reconnect behavior.

这一步必须在 “KB Codex adapter” 之前完成。目标是重构现有代码，而不是立即加入 Codex 功能。

重构内容：

- 将现有 Claude workshop 启动、resume、ready detection 收入明确的 `cc` runtime adapter；
- 将 Channel 中 Claude consumer 特有逻辑与 runtime-neutral routing/binding 分开；
- 为 capture 定义 runtime-neutral transcript/turn 输入格式；
- 为 distill 提取 `DistillRuntime` executor 边界，同时保持现有 Claude worker 行为；
- 将安装目标抽象成 Claude/Codex 可扩展的配置、Skill、hook 安装步骤；
- 保持现有 public CLI、配置默认值和 Claude 生产行为不变。

重构必须由 Phase 0 的 characterization test 保护。退出条件是：没有启用 Codex 时，现有 Claude、Channel、Workshop、KB、Cron 的单元、集成和 E2E 结果与基线一致。

### Phase 3：KB Codex adapter

Status (2026-07-19): complete. Codex rollout capture, per-turn deduplication,
runtime-selectable distillation, hook deployment, and isolated tests are in place.

实现 Codex MCP、Skills、`AGENTS.md`、capture，以及独立 `codex exec --json` distill executor。证明 Codex-only 的：

```text
rollout -> capture -> raw -> distill -> topics -> reindex -> kb_search
```

退出条件：增量捕获不重复；watermark/back-reference 正确；Channel daemon 关闭时 distill 仍可完成；失败 sentinel 和 backlog drain 保持现有语义。

### Phase 4：Telegram Channel

Status (2026-07-19): implementation complete, pending an opt-in live-bot gate.
The fake-platform black-box E2E covers persistent bindings, FIFO turns, editable
message streaming, approval commands, interrupt, and runtime-name collision safety.

实现 Codex App Server runtime bridge、持久化 binding、FIFO、去重、streaming、interrupt、基础 approval 和重启恢复。

退出条件：Telegram live E2E 能驱动持久化多轮 thread，并验证 Channel daemon/App Server 分别重启后的恢复。

### Phase 5：Lark Channel

Status (2026-07-19): complete. Per-group bindings, persistent Codex threads,
approval commands, interrupt, and CardKit 2.0 streaming reuse the shared bridge.
Card creation, ordered Markdown updates, and stream finalization run through the
authenticated `lark-cli` bot identity; failures degrade to final webhook delivery.

复用同一个 Codex runtime bridge，增加 Lark chat/thread binding、CardKit streaming 和 approval card。

退出条件：Lark live E2E 验证 group/thread 隔离、流式答复、审批、去重和重启恢复。

### Phase 6：混合 Workshop

Status (2026-07-19): complete. The Codex adapter implements TUI launch,
cwd-filtered `resume --last`, safe first-run fallback, ready detection, and prompt
injection. Mixed-runtime schema and Docker contract tests pass while unsupported
runtimes continue to fail closed.

实现 `runtime: cc|codex`、headless Codex mate、status/doctor，以及 Claude/Codex 通过 Channel bus 互发任务。

退出条件：Docker/本机 E2E 启动混合 workshop，验证 cwd/session 隔离、单 mate 重启、全局重启和跨 runtime 消息。

### Phase 7：Cron 迁移

Status (2026-07-19): complete. Imported `kb-distill` jobs now run
`ka kb distill --background` through the `ka-cli` cron backend. Runtime selection
remains inside KB via `distiller.runtime`, so scheduled Codex distillation does
not require a live Channel session or Workshop TUI.

将新 distill schedule 收敛到直接执行 `ka kb distill`，由 KB 选择 executor；迁移旧 inject-prompt job，并保持 daemon keepalive 行为不变。

退出条件：隔离 HOME 下的 Cron E2E 验证 Codex-only 定时 distill，不依赖在线 Channel/TUI；旧配置得到明确迁移提示。

### Phase 8：可选增强

在前述验收完成后，再评估 steer、其他 Codex surface attach、Unix socket control、多 client 并发和 App Server compatibility matrix。

## 11. 测试策略

测试不是开发完成后的补充工作。每个 Phase 都必须同时提交对应测试，并在进入下一 Phase 前通过本阶段退出条件。

### 11.1 测试层次

#### 单元测试

- JSON-RPC request/response correlation；
- event normalizer；
- binding 原子读写、schema 和迁移；
- FIFO、去重、限频和 retry；
- approval state machine；
- Codex rollout parser 与 capture watermark；
- distill runtime selection；
- workshop/cron 配置解析。

#### 组件集成测试

- fake App Server 子进程测试 initialize、event、approval、崩溃和 restart；
- 使用临时 `CODEX_HOME` 的真实 `codex app-server` 协议测试；
- fake Telegram/Lark API + 真实 Channel core；
- fake runtime + 真实 platform；
- Codex capture -> raw 与 Codex distill executor 的隔离集成测试；
- Cron backend -> `ka` command dispatch。

#### 仓库 E2E

优先扩展现有测试基础设施，而不是建立第二套互不相干的 harness：

- `channels/telegram/tests/e2e.test.ts`；
- `channels/lark/tests/e2e.test.ts`；
- `tests/e2e-test.sh`；
- `tests/run-all-in-docker.sh`；
- KB 现有 capture/distill/retrieval tests。

Docker E2E 使用隔离的 HOME、`CODEX_HOME`、`KA_HOME`、临时 workspace、端口和凭据，不读取或修改开发者真实配置。

#### Live E2E

真实 Codex 登录、Telegram bot、Lark app 或真实模型调用需要凭据和网络，因此必须显式 opt-in，不进入默认离线测试：

```text
KA_LIVE_CODEX_E2E=1
KA_LIVE_TELEGRAM_E2E=1
KA_LIVE_LARK_E2E=1
```

live test 必须使用专用测试 chat/workspace，严禁复用生产 bot 的消费循环，否则 Telegram long polling 会产生 `409 Conflict`。

### 11.2 核心 E2E 场景矩阵

| 部分 | 场景 | 必须验证 |
|---|---|---|
| App Server | 新建 thread 并完成 turn | streaming、final、session 落盘 |
| App Server | 重启并 resume | threadId、上下文连续性 |
| App Server | 两 thread 并发 | cwd、事件和输出不串线 |
| App Server | approval/interrupt | allow、deny、timeout、stop |
| Channel | Telegram -> Codex -> Telegram | binding、去重、流式和 final |
| Channel | Lark thread -> Codex -> Lark | thread 隔离、CardKit/fallback |
| Channel | daemon/App Server 分别重启 | 自动恢复且不重复 turn |
| KB | Codex rollout capture | 增量 offset、turn 去重 |
| KB | Codex distill | raw/topic/back-reference/stats |
| KB | distill 失败后重跑 | sentinel、watermark、backlog |
| KB | distill 后查询 | 增量 reindex、`kb_search` 命中 |
| Workshop | Claude + Codex 混合启动 | cwd/session 隔离、status |
| Workshop | mate 重启 | binding 和持久化 thread 恢复 |
| Cron | Codex-only scheduled distill | 无 Channel/TUI 依赖 |
| 回归 | 原 Claude 全链路 | 行为与重构前一致 |

### 11.3 测试门禁

每个 Phase 合并前至少满足：

- 相关单元和组件测试通过；
- 新增行为有失败路径测试；
- 受影响的四部分 E2E 通过；
- Claude 回归测试通过；
- `git diff --check` 和 build/typecheck 通过；
- live E2E 若因凭据无法在 CI 执行，必须记录最近一次人工/受控环境结果和可复现命令。

## 12. 已确认的默认决策

1. Channel 使用 App Server 作为 Codex 主通信通道。
2. Channel 第一版由一个受监管 App Server 管理多个持久化 thread。
3. Channel 的 `codex exec --json` 只作降级路径。
4. KB 的 Codex distill 使用独立 `codex exec --json` executor，不依赖 Channel App Server。
5. 正常用户 Channel thread 持久化；内部 distill task 可以 ephemeral。
6. Codex workshop mate 第一版为 headless thread。
7. Claude 路径保持行为兼容。
8. thread 输入使用串行 FIFO，`/stop` 中断 active turn。
9. 默认保留 sandbox 和显式审批。
10. Cron 直接触发所属部分的 `ka` 命令，不把 prompt injection 作为新架构主路径。
11. Codex 功能开发前先完成保持行为不变的 runtime-boundary 重构。
12. 正式研发在独立 feature branch 上进行，不能直接在 `main` 开发。
13. 测试与实现同阶段提交，E2E 是每个功能部分的退出门禁。

## 13. 参考资料

- [OpenAI Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [OpenAI 实验性 Codex MCP server 接口](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md)
- [mideco-tech/codex-tg](https://github.com/mideco-tech/codex-tg)
- [francize/agents-to-im](https://github.com/francize/agents-to-im)
- [cloveric/tarocub](https://github.com/cloveric/tarocub)
