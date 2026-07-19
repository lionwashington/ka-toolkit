# Codex App Server 协议验证记录

> 日期：2026-07-19  
> 分支：`feat/codex-runtime`  
> Codex CLI：`0.144.6`

## 1. 结论

Implementation follow-up (2026-07-19): the validated protocol client now has a
production counterpart in `channels/core/src/codex/`. Telegram and Lark daemon E2E
tests exercise the shared runtime bridge without connecting to production channels.

Phase 1 的关键假设已得到验证：KA 可以把 `codex app-server` 作为独立子进程，通过 stdio JSONL 控制 headless Codex thread，无需 Codex TUI。

已验证：

- `initialize` / `initialized` handshake；
- `thread/start`；
- `turn/start`；
- `thread/started`、`turn/started`、agent message delta、`item/completed`、`turn/completed`；
- client 对 server-initiated approval request 的响应方向；
- request timeout 和子进程退出时清理 pending request；
- 一个 App Server 退出后，新 App Server 按 `threadId` 执行 `thread/resume`；
- 非 ephemeral thread 写入隔离 `$CODEX_HOME/sessions`；
- resume 后模型上下文连续。

这证明整体技术路径可行。并发、interrupt、畸形 event 和 supervisor 有界重启也已补齐，Phase 1 的退出条件已满足，可以进入 runtime-boundary 重构。

## 2. 测试资产

```text
tests/codex-app-server/
|- client.mjs              最小 stdio JSON-RPC client
|- fake-app-server.mjs     可控的 fake server
|- client.test.mjs         默认离线测试
|- live-smoke.mjs          真实 ephemeral App Server smoke
|- live-persistence.mjs    真实持久化 + 跨进程 resume E2E
`- live-concurrency-interrupt.mjs 真实双 thread + interrupt E2E
```

默认 `pnpm test` 会运行 `client.test.mjs`，不访问网络、不读取真实 Codex 登录状态。

真实测试必须显式 opt-in：

```bash
KA_LIVE_CODEX_E2E=1 node tests/codex-app-server/live-smoke.mjs
KA_LIVE_CODEX_E2E=1 node tests/codex-app-server/live-persistence.mjs
KA_LIVE_CODEX_E2E=1 node tests/codex-app-server/live-concurrency-interrupt.mjs
```

## 3. 离线协议测试

fake server 覆盖：

1. initialize、持久化 thread start、delta/completed event；
2. fake server 退出后，由新进程从测试 state 恢复同一 thread；
3. server-initiated approval request 与 client decision；
4. request timeout；
5. child exit 时拒绝所有 pending request。

另外覆盖两个 cwd/thread 并发隔离、interrupt、畸形 JSON 后继续处理，以及 supervisor 在连续崩溃时的有界退避重启。

当前结果：`6/6` 通过。

## 4. 真实 ephemeral smoke

真实 App Server 成功返回：

```text
userAgent: ka-codex-spike/0.144.6
thread.ephemeral: true
thread.path: null
final: KA_CODEX_APP_SERVER_OK
turn.status: completed
```

观察到真实事件序列：

```text
thread/started
thread/status/changed
turn/started
item/started (userMessage)
item/completed (userMessage)
item/started (agentMessage)
item/agentMessage/delta ...
item/completed (agentMessage)
thread/tokenUsage/updated
thread/status/changed
turn/completed
```

这证明 Channel 可以完全依赖结构化事件渲染消息，无需解析 TUI。

## 5. 真实持久化与恢复

测试使用临时目录作为隔离 `CODEX_HOME`：

1. 将本机 `auth.json` 临时复制到权限为 `0700` 的测试目录；
2. 启动 App Server A；
3. 创建 `ephemeral: false` thread；
4. 完成第一轮并要求记住随机 marker；
5. 停止 App Server A，确认 `thread.path` 对应 rollout 已落盘；
6. 启动 App Server B；
7. 使用同一 `threadId` 执行 `thread/resume`；
8. 发起第二轮并确认正确返回 marker；
9. 删除整个临时 `CODEX_HOME` 和 workspace。

结果：持久化、跨进程 resume 和上下文连续性均通过。测试未在用户正常 `$CODEX_HOME/sessions` 中留下 thread。

## 6. 真实并发与 interrupt

在同一个真实 App Server connection 上创建两个不同 cwd 的 ephemeral thread：第一个 turn 在收到 `turn/started` 后执行 `turn/interrupt`，第二个 turn 同时正常完成并返回独立 marker。

结果：第一个 turn 的最终状态为 `interrupted`，第二个为 `completed`，无跨 thread 事件串扰。

这里确认了一个重要时序：`turn/start` response 的 `turn.status` 可以已经是 `inProgress`，但服务端尚未发出 `turn/started`。在此窗口调用 `turn/interrupt` 会返回 `no active turn to interrupt`。Channel bridge 必须以 `turn/started` notification 作为可 interrupt 的状态门禁；interrupt RPC 成功后，仍需等待 `turn/completed(status=interrupted)`，才能对外宣告终止完成。

## 7. 发现与后续约束

### App Server 会加载当前 Codex 配置

使用真实默认 `CODEX_HOME` 的 smoke 中，App Server 尝试启动用户配置的全部 MCP server。一个已有 `telegram` MCP 配置启动失败，但不影响本次 Codex turn 完成。

后续 Channel bridge 需要：

- 监听并区分 MCP startup status；
- 不因一个非关键 MCP server 失败而判定整个 App Server 不可用；
- 在测试中使用隔离 `CODEX_HOME` 或明确的最小配置；
- 在生产中通过 `doctor` 展示失败的 MCP，而不是吞掉状态。

### `thread.path` 是不稳定字段

当前 schema 将 `Thread.path` 标为 `[UNSTABLE]`。binding 的恢复主键必须是 `threadId`；`thread.path` 只用于诊断、capture 和验证，不得成为唯一恢复依据。

### App Server process 与 thread 生命周期分离

App Server process 可以退出，而持久化 thread 仍然存在。Channel 的 supervisor 应管理进程健康；binding store 管理 thread identity，二者不能混成同一状态。

### 默认测试不能依赖真实登录

真实模型测试受登录、配额和网络影响，只能显式 opt-in。CI 默认门禁使用 fake server；受控环境定期运行 live smoke/persistence。

## 8. 现有项目基线

正式修改前已记录以下基线：

- `pnpm build`：通过；
- `pnpm test`：通过；
- Lark E2E：`15/15` 通过；
- Docker E2E：`17/17` 通过；
- Docker 内真实 cron tick 未在 75 秒内出现，按测试既有设计 skip；直接 runner contract 通过。

构建和本地 daemon E2E 在受限沙箱中分别遇到 IPC socket/listen 权限限制，获准在正常本机环境运行后通过，不属于代码失败。
