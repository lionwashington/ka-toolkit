# telegram-channel daemon — Architecture Design

> **Status**: as-built (implemented and deployed, aligned with the actual code: the channel-core kernel `channels/core/src/` + the telegram platform adapter `channels/telegram/telegram-platform.ts`).
> **Ground truth**: `channels/core/src/` (kernel: `daemon.ts` / `http.ts` / `dispatch.ts` / `sessions.ts` / `probe.ts` / `routing.ts`) + `channels/telegram/telegram-platform.ts` (telegram polling/send/identity) — the code is authoritative for mechanism; process/start-stop helpers in `daemon.sh` / `start.sh` / `tg-ch`.
> **This document is the single authoritative reference for the telegram-channel architecture**, including CC↔CC (cc2cc) internal communication (see §5 CC↔CC cc2cc communication).

---

## 1. Overview and Purpose

The telegram-channel daemon is a **standalone long-running background process** that bidirectionally bridges the **owner's Telegram DM** with **multiple Claude Code (CC) processes**.

The core problems it solves:

- **Decouple Telegram I/O from CC lifecycle**. The daemon runs long-lived independently of any CC process; CC start/stop, compact, and crashes do not affect the Telegram connection.
- **One daemon, many channels**. A single daemon is one message bus; each CC process connects as a named **channel**. The user routes a message to a target CC with a `to <name>:` prefix (or number).
- **Credential isolation (security invariant)**. The bot token **lives only in the daemon process**; no CC process (including any mate) **ever touches the token** — they send/receive messages solely through MCP. Credentials have a single egress point (see §8).

An end-to-end illustration (user → CC → user):

```
User Telegram DM
  │ ① getUpdates long-poll (offset cursor, daemon owns the token exclusively)
  ▼
telegram-channel daemon  (node + express @ 127.0.0.1:9877, port-binding singleton, cron self-heal)
  ├─ inbound: getUpdates → owner filter → parseRoutingPrefix → save offset → dispatch
  │ ② notifications/claude/channel (meta all String) over /mcp SSE
  ▼
CC processes (each attached to some channel: byName["ka"], byName["main"] …)
  │ ③ CC calls mcp__telegram-channel__reply{chat_id, text}
  ▼ POST /mcp
daemon ── ④ bot.api.sendMessage(owner, "**[#N-name]** " + text) ──▶ user Telegram
```

The terminal transcript never reaches the user; the user only sees what the CC proactively sends via the `reply` tool.
Codex streaming instead separates that prefix from the body with a blank line.
Long Telegram replies are split at transport limits without removing newline
characters, so chunking cannot collapse paragraphs. An active Codex stream edits
the first chunk; finalization sends any remaining chunks as follow-up messages.

---

## 2. Process Model

- **A single long-running daemon**: a node + express process listening on **MCP-over-HTTP @ `127.0.0.1:9877`** (loopback-only).
- **Independent of any CC**: the daemon's `getUpdates` polling loop and its MCP client connections are independent of each other — even when no CC is connected, the daemon keeps polling Telegram (offset advancement rules in §4).
- **Singleton = port binding**: `daemon.sh` uses `flock` on Linux; macOS has no `flock`, so it `exec node` directly and relies on the **port-binding singleton** in the channel-core kernel as a fallback — a second daemon hits `EADDRINUSE` and cleanly exits with `process.exit(0)`, no crash (see `channels/core/src/daemon.ts` `httpServer.on('error')`).
- **Deployment location**: the deployed daemon directory `~/.knowledge-assistant/channels/telegram-daemon/` (per what install.sh actually lays down). Source lives in the repo at `channels/telegram/`, copied to the daemon directory via the install/deploy flow; runtime files (`state.json` / `daemon.pid` / logs / `node_modules/`) live only in the daemon directory and are not committed to git. Secrets live in `~/.knowledge-assistant/config/secrets.yaml` (not in the daemon directory, not in git).
- **HTTP endpoints**:
  - `POST/GET/DELETE /mcp` — MCP Streamable HTTP transport (CC connects as an MCP client).
  - `GET /api/status` — JSON health status (uptime, sessions, counters, channel_alive, offset).
  - `POST /api/shutdown` — graceful shutdown (loopback only).
- **Supervision**: `cron` (`* * * * * start.sh`) provides idempotent self-healing — if the daemon dies it is relaunched within ≤60s by `start.sh` (`start.sh` first probes `/api/status`; if already up it just returns).
- **Configuration sources** (the daemon reads `~/.knowledge-assistant/config/` directly; no per-daemon `config.json` / `.env`):
  - `config/secrets.yaml` → `channels.telegram.{token, owner_chat_id}` — the bot token and the single allowed owner. The daemon **fails closed** on an empty token or owner (no fallback, no default).
  - `config/config.yaml` → `channels.telegram.{port, ...}` — non-secret host/port/poll tuning.

> Note that the grammy `Bot` is used only for raw API calls (`getUpdates` / `sendMessage`) and **never calls `bot.start()`** — otherwise grammy would spin up its own long-polling loop and compete with this daemon for "the single allowed getUpdates consumer". The offset cursor is advanced manually by the daemon.

---

## 3. Connection and Session Model

- **Transport**: `StreamableHTTPServerTransport` (MCP SDK). Each CC connects to `/mcp` as an MCP client.
- **The channel name comes from the URL query `?name=`**: on a new connection, `sanitizeChannelName((req.query).name)` extracts the channel name. There is no argv/env source.
  - sanitize: `String(raw).toLowerCase().replace(/[^a-z0-9_-]/g,'')`, empty → default `'main'`. Only `a-z0-9_-` allowed (e.g. `weex.repo` → `weexrepo`).
- **Definition of "session"**: one CC MCP connection = one session (`{ id, server, transport, name, createdAt, monoTs, consecutiveFails, lastProbeOk, staleSince? }`). `id` is the mcp-session-id (UUID). When a CC is attached to a channel it may have ≥1 session (the tool client + the dev-channels consumer connection).
- **Two routing tables** (kept strictly in sync):
  - `byName: Map<name, Session[]>` — the primary store, **per-name FIFO**. A new init `push`es to the tail; exceeding `PER_NAME_FIFO_CAP` (4) → `shift`s the oldest (also deletes it from `sessionsById` and closes its transport). Dispatch iterates the entire list (in parallel) to ensure the dev-channels consumer (which may land on any recent session) receives the notification. The "owner" (used for display/numbering) = the newest session (`list[length-1]`).
  - `sessionsById: Map<id, Session>` — an auxiliary index. Inbound HTTP requests carry the mcp-session-id (UUID), not the channel name, so this table routes a request to the correct transport.
- **New-connection handshake** (`app.all('/mcp')`):
  - Request carries a known `mcp-session-id` → reuse that transport (the existing branch).
  - **GET SSE reconnect with an unknown session-id + `?name=`** → **"re-adopt"**: do not 404; rebuild the session on the spot from `?name`, reuse the old id, and reconnect the consumer's SSE stream (see §6c — the key to automatic inbound recovery).
  - **Any other request with an unknown session-id** (a POST, or a GET without `?name`) → **return 404 (JSON-RPC -32001)**, forcing the tool client to re-run the initialize handshake (outbound self-heal, see §6).
  - No session-id (a new connection) → take `?name=` → `new StreamableHTTPServerTransport`, `onsessioninitialized` = addSession, `transport.onclose` = removeSession.

---

## 4. Inbound Path (Telegram → CC)

A single `pollLoop()`: a `bot.api.getUpdates({ offset, timeout: poll_timeout, allowed_updates: ['message'] })` long-poll loop (not per-group). Each update goes through `handleUpdate`:

1. **owner-only filter + empty-message discard**: a deliverable message must have `from.id === OWNER_ID` and carry text **or** one of the attachment types. Everything else → advance the offset (acked) but do not deliver. This prevents prompt injection.
2. **replay semantics (don't advance offset when there are no sessions)**: `sessionsById.size === 0` → do not advance the offset and `break` the batch (`'stop'`), so messages sent while the user was offline are replayed once a CC reconnects.
3. **offset is the single source of truth for dedup**: **before** delivering, set `state.offset = update_id + 1` + `saveState`. A crash or session churn after delivery will not re-deliver the same `update_id`.
4. **routing-prefix parse** `parseRoutingPrefix(text || caption)` → **sticky routing** `applyStickyRouting(parsed, last_target)`:
   - Accepts the prefix `to` (case-insensitive) or `2` (homophone); the target may be a channel name or a **number**, or a **comma-separated list** (multi-target); the colon `:`/`：` is optional.
   - prefix + colon → explicit targeting (routes even if the target is offline, to give feedback).
   - **No prefix (bare message) → sticky**: reuses `state.last_target` (the last **single** target this chat routed to). `applyStickyRouting` (`channels/core/src/routing.ts`, shared with lark) records `last_target` only on an explicit **single, non-`all`** target; a multi-target or `to all` does **not** update it. No `last_target` yet (first ever) or the remembered target offline → core returns an EMPTY target list → daemon prompts the owner to pick a channel + lists who's online (**no silent default to `main`**). `last_target` is persisted in `saveState`, surviving restarts.
   - Numbers are resolved via `nameByNumber` (see §7).
5. **attachment download**: an update is more than just `message.text`. `extractAttachment` recognizes `photo` (takes the largest size) / `document` / `video` / `audio` / `voice` / `animation` / `video_note` / `sticker` → `bot.api.getFile` + download to `attachments/<update_id>-<file>` → on delivery the meta gets `attachment_path=<local absolute path>`. When there is no caption, the content is a placeholder (`[图片]` / `[语音]` / `[附件: name]` …). When the consumer receives an `attachment_path`, it views the attachment with the **Read tool**.
   - 🔴 **hard download timeout `DOWNLOAD_TIMEOUT_MS` (12s)**: `getFile` + `fetch` are on the single-threaded critical inbound path. To prevent a slow download from blocking single-threaded inbound, downloads have a 12s hard timeout (`AbortController`); on timeout it degrades to text-only delivery (the message is never dropped; the offset was already advanced, so replay/dedup are unaffected). The bot token never leaves the daemon (the download URL is assembled and consumed inside the daemon).
6. **dispatch → fanout**: `dispatch(targetName, content, meta)` → iterates **all** sessions in `byName[target]`, with `fanout` using `Promise.allSettled` to deliver in parallel + a 5s timeout per delivery (a half-dead session does not block live consumers, avoiding head-of-line blocking). method `notifications/claude/channel`, params `{ content, meta }`.
   - 🔴 **every meta field must be `String()`** (`fanout` uniformly does `Object.entries(...).map([k,v]=>[k,String(v)])`). Numeric/object fields cause the dev-channels consumer to **silently drop the entire notification** (the top invariant). The telegram inbound meta: `{ chat_id, sender_name, sender_id, message_id, ts, [attachment_path] }`, all String.
   - target has no session and it's not a broadcast → send the owner a Telegram notice "channel offline + online list" (`route_miss_total++`).
7. **typing ACK (a lightweight "read receipt")**: after dispatch successfully pushes to ≥1 session, send the owner `bot.api.sendChatAction(chat_id, 'typing')` → the user's Telegram window shows "typing…" at the top, indicating the CC received the message and is working on it. Fire-and-forget (`.catch` swallows; never blocks the message flow).
   - 🔴 **only sent on the telegram inbound path (`dispatch`)**; CC↔CC (`send_to_channel` calls `fanout` directly) does not ACK.
   - Telegram auto-clears it in ~5s = "received", not "processing the whole time". Its accuracy depends on `targets` being live sessions — relying on the §6 ping probe to clear zombies, otherwise a phantom delivery to a dead session would send a false ACK.

---

## 5. Outbound Path

Two outbound paths (`reply`, `send_to_channel`) plus one read-only query tool (`list_channels`) —
every per-session MCP server registers all three.

### 5a. `reply` → the user's Telegram

```
reply({ chat_id: string, text: string })
```

- → `sendToTelegram(owner_chat_id, "**[#<num>-<name>]** " + text)`, using grammy `bot.api.sendMessage`, plain text (no parse_mode, to avoid the `**[name]**` prefix or arbitrary body triggering markdown parsing).
- **chunk(4096)**: a single Telegram message is capped at 4096 characters; overlong text is split near paragraph boundaries without deleting the boundary characters. Codex streaming previews the first chunk and sends remaining chunks at completion.
- **prefix `**[#<num>-<name>]**`**: a stable number + channel name, so the user can tell which session replied and route back by number (`to 7:`). See §7 for numbering.
- 🔴 **security**: no matter what `chat_id` a CC passes, the daemon **always sends only to the configured owner**. An injected/compromised CC cannot use `reply` to message an arbitrary chat — `chat_id` remains a required parameter (the CC follows the protocol), but it is **not trusted to route the outbound target**.

### 5b. `send_to_channel` → another CC (CC↔CC / cc2cc)

> This section describes CC↔CC (cc2cc) internal communication. CC↔CC **does not start a new daemon**; it reuses the same daemon, the same `byName` routing table, and the same `fanout`. Each CC is one channel on the bus.

**Requirement**: the user wants a main CC to coordinate multiple mate CCs **without** using Claude Code's team-mate mechanism (which implicitly shares a workspace/cwd and has the lead spawn them). The user wants mates to each run in an independent workspace, start/stop independently, and collaborate purely via "messages". telegram-channel already connects "external user ↔ multiple CCs"; cc2cc uses the same mechanism to connect "CC ↔ multiple CCs".

**Tool**:

```
send_to_channel({ target: string, text: string })
```

- `target`: the target channel name (sanitized by `sanitizeChannelName`) or `'all'` (broadcast).
- Semantics: the daemon dispatches `text` as a single `notifications/claude/channel` to all sessions in `byName[target]` (or `allSessions()` when `target='all'`). **Does not go through Telegram.**
- **offline**: target has no session → **synchronously returns isError + a list of online channels** (no queuing, no telegram; the caller gets immediate feedback and can retry).

**The reply mechanism `from_channel` (analogous to telegram's chat_id)**: when dispatching to the target CC, the meta injects the initiator's identity (all String):

```
notifications/claude/channel
  params:
    content: <text>
    meta:
      source:       "cc"        // distinguishes from a telegram source
      from_channel: "<initiator channel name>"   // = the calling session's name
      ts:           "<second-level timestamp>"
      channel_name: "<target channel name>"      // injected by fanout
      routed_target: "<routed target>"           // injected by fanout
```

- 🔴 **`from_channel` is injected by the daemon based on the caller session's `name` (the closure-bound `channelName`), never trusting what the CC self-reports** → unforgeable.
- The target CC replies to the initiator with: `send_to_channel(target=<from_channel>, text=...)`.

One round trip (main directs ka, ka reports back):

```
main CC ── send_to_channel("ka", "look up X") ──▶ daemon
daemon  ── dispatch byName["ka"], meta.from_channel="main" ──▶ ka CC
ka CC   ── send_to_channel("main", "the result of X is…") ──▶ daemon
daemon  ── dispatch byName["main"], meta.from_channel="ka" ──▶ main CC
```

**The `source` distinction**: the consumer decides its reply path from the meta `source` — `source="telegram"` uses `reply` (→ user); `source="cc"` uses `send_to_channel` (→ the initiating CC). A main CC can simultaneously be telegram's `main` channel **and** the mate coordinator.

**Broadcast self-exclusion**: when `target='all'`, `allSessions().filter(s => s.name !== channelName)` — a CC does not receive its own `to all:` broadcast; no other channel online → isError.

**loop-guard (soft)**: ① the consumer instructions explicitly say "don't reflexively bounce" (two CCs auto-replying to each other create an infinite loop); ② a lightweight `ccLoopGuard`: if the same `from→to` pair dispatches > `CC_LOOP_MAX` (5) times within `CC_LOOP_WINDOW_MS` (2s) → `log WARN cc-loop` (warning only, no hard block). Hard rate-limiting is future work.

**Audit / counters**: every cc dispatch writes `log("cc-dispatch from=<X> to=<Y> [N sess]")` (successful reply/send are not logged by default); `cc_dispatches_total` goes into `/api/status` (offline is not counted).

**Delivery guarantee**: CC↔CC has no telegram offset persistence; it's immediate delivery. Messages during a daemon restart / target-CC reconnect window may be lost. A persistent queue is future work. CC↔CC currently does not carry attachments.

### 5c. `list_channels` → the live roster (read-only query)

```
list_channels()   // no arguments
```

- Returns every channel currently connected to this daemon, each with its stable **number**,
  **name**, and **live status**. `alive` is sourced identically to `GET /api/status` — a probe
  ping succeeded within `CHANNEL_FRESH_MS` (or the session is still in its creation grace) — so it
  is **real-time liveness from the ~5s ping probe (§6)**, not an inference from logs.
- A CC uses it to see who is online **before** `send_to_channel` / a broadcast. It is the only
  in-MCP way to check the roster (before it, a CC had no tool for this — the info lived only in
  `/api/status` / `ka channel status`).
- Read-only: it never sends a message anywhere.

The division of labor between the tools:

| Tool | Destination | Use |
|---|---|---|
| `reply{chat_id,text}` | `bot.api.sendMessage` → **user Telegram** | CC replies to the user |
| `send_to_channel{target,text}` | daemon `fanout` → **another CC channel** | CC ↔ CC |
| `list_channels{}` | read-only (no send) | CC checks who is online (number / name / alive) |

---

## 6. Liveness Detection and Self-Healing

### 6a. keepalive probe — standard MCP `ping`

- **Mechanism**: every `PROBE_INTERVAL_MS` (5s), send each session a **standard MCP `ping` request** (server→client) + a `PROBE_TIMEOUT_MS` (4s) timeout, **in parallel** (a dead session's 4s timeout doesn't block probing the others, avoiding head-of-line blocking).
  - pong returned → `consecutiveFails=0` + `lastProbeOk=now` (if it had been stale, clear `staleSince` and log `RECONNECTED`).
  - timeout/reject → `consecutiveFails++`; reaching `CONSECUTIVE_FAIL_LIMIT` (3) outside the grace period → triggers the half-open self-heal in §6b.
- **Why ping rather than a write-only probe**:
  - **A write-only probe cannot detect death (the root cause is in the SDK layer)**: MCP `StreamableHTTPServerTransport.send()` **silently no-ops on a disconnected standalone SSE stream** (SDK source comment: "Stream is disconnected — nothing more to do; return"), so the write **never throws**; and SIGKILL **does not trigger `transport.onclose`**. Therefore a write-only probe is **architecturally unable to detect death** — a SIGKILL'd CC keeps `alive=true` indefinitely and accumulates zombie sessions.
  - **Why ping doesn't kill live sessions by mistake**: the standard MCP `ping` is a protocol-level utility — the SDK's `Protocol` base class auto-registers a ping handler on construction, so **any compliant MCP client (including the dev-channels consumer) auto-replies with pong at the protocol level**, with no consumer application-layer implementation needed. A live session therefore always returns pong and is never misjudged as dead.
- **age-based grace**: only newly created sessions **< `PROBE_GRACE_MS` (10s)** old are granted grace (to avoid killing a session before its ping responder is ready).
- **channel_alive** (`/api/status`): the criterion = "**a ping succeeded within the last `CHANNEL_FRESH_MS` (15s)**" (rather than `lastProbeOk > 0`, which would mean "alive at some point" stays permanently true → a dead session would show alive forever); a newly created session (`lastProbeOk===0`) gets the creation grace.

### 6b. Connection half-open self-heal

- **Scenario**: network jitter / sleep-wake → the CC↔daemon SSE goes one-way half-open (the daemon's `send()` silently no-ops on the broken stream, the CC doesn't receive dispatches, but TCP isn't broken and both ends think they're connected). The §6a ping probe can detect this (pong timeout).
- **Mechanism**: when consecutive probe failures hit the threshold (the first time reaching `CONSECUTIVE_FAIL_LIMIT`) → call **`transport.closeStandaloneSSEStream()`** (an SDK method: closes only the server→client notification stream, triggering the client to reconnect per SSE retry, **keeping the session, not deleting it**) + mark `staleSince` + `probeReconnectTriggeredTotal++`. The CC reconnects with the **same session-id** → the daemon goes through the §3 existing branch and seamlessly reconnects (probe recovers → clears `staleSince`, logs `RECONNECTED`). Only if ping still fails for more than `STALE_EVICT_MS` (60s) after `staleSince` (the CC is truly dead, e.g. SIGKILL) does it finally `removeSession` + `probeEvictedTotal++`. This cures both half-open deadlock and zombie-session leaks.
- 🔴 **Key design**: uses `closeStandaloneSSEStream()` (close the stream, keep the session) rather than `transport.close()` (destroy the session), because the latter would delete the session and degenerate into the "GET-404 lie-flat deadlock" described below.

### 6c. The "re-adopt" of a reconnection — the daemon does not 404 a reconnect bearing `?name`

A CC has [two] independent connections to the daemon: ① the **tool client** (POSTs to call tools, cc→daemon, outbound) ② the **dev-channels consumer** (a GET-only standalone SSE that passively receives dispatches, daemon→cc, inbound). After a daemon restart / session loss, both must reconnect, and the daemon handles them on two paths:

- **POST (tool client) with an unknown id** → returns 404 (JSON-RPC -32001) → the client proactively re-runs initialize → reconnects. Outbound self-heals (inherent client behavior, naturally triggered when the CC next calls a tool).
- **GET SSE reconnect (consumer) with an unknown id + `?name=<channel>`** → **does not return 404 but "re-adopts"**: builds a session on the spot from `?name`, **reuses the old session-id the client brought**, pre-sets the transport internal state (`_webStandardTransport.sessionId=old id`, `_initialized=true`, bypassing the SDK's "must POST initialize first" gate), manually `addSession`s, then `handleRequest` opens the standalone SSE. That one passive SSE retry from the consumer reconnects successfully → **inbound recovers automatically, zero intervention** (not even a touch is needed).

🔴 **Key invariant (set by the lead, not to be violated): the daemon must never return 404 to a "reconnect bearing `?name`" and must never removeSession.** Because the consumer is GET-only and, on hitting a 404, retries only twice before lying flat and never re-handshaking (an inherent claude client behavior) — once 404'd, it permanently stops receiving messages, while the tool client still works, manifesting as the classic "**can send but can't receive**". re-adopt closes this hole: a reconnect bearing `?name` is always re-adopted; even if the daemon doesn't recognize the old id, it can rebuild on the spot from `?name`. (This overturns the old version of this document's conclusion that "the daemon cannot build a session in place of the client from a single GET / the protocol layer cannot recover unilaterally" — it's verified to work in practice; see the e2e `re-adopt` case.)

Historical lesson: the old version (which from c017006 copied lark's "404 any unknown id" logic) caused every CC's receive line to be permanently broken after each daemon restart, requiring a CC restart to receive again. After the re-adopt fix, a fast restart automatically recovers both directions.

### 6d. Daemon-restart recovery (re-adopt, automatic) + the long-downtime boundary

- **Fast restart / deploy (downtime < ~2.5s, the everyday case)**: process swaps → all in-memory sessions are lost → the tool client POST hits 404 and re-inits itself (outbound), the consumer GET bearing `?name` is re-adopted (inbound). **Fully automatic, no CC restart, no touch.** Verify via the `RE-ADOPT … consumer SSE reconnect, no 404` log + the CC actually receiving messages. `ka workshop --restart-daemon` is "restart only the daemon" — the restart is fast (downtime ~1.5–2s), each CC reconnects automatically via re-adopt, no more kill/relaunch of CCs.
- **Long-downtime boundary (downtime ≫ 2.5s, e.g. a crash left unattended for an hour)**: the consumer SSE client retries only twice by default (SDK `maxRetries=2`, delays 1s→1.5s, ~2.5s window) before giving up. If the daemon comes back outside that window → the consumer has lain flat and won't reconnect → re-adopt has nothing to trigger on. At that point:
  - **touch (having the CC call a tool once) only saves outbound** (tool client POST→404→re-init), **it cannot save inbound** — the consumer is an independent connection that touch does not trigger (verified: the CC can keep calling tools to send and reply, but still never receives, until the CC is restarted).
  - **The only reliable means for inbound: restart that CC** (`ka workshop restart <name>`, so the dev-channels consumer connection is rebuilt fresh). A long downtime requires manual intervention anyway, so restarting the CC at the same time is fine.

> Platform-agnostic: all of 6a/6b/6c live in `channel-core` (probe.ts / http.ts) and are unrelated to telegram-platform. Once LarkPlatform connects to the same core it automatically gets re-adopt and all the other capabilities.

---

## 7. Channel Numbering and Persistence

- Stable numbers are persisted in `state.json`'s `channel_numbers` (`name → number`) + `next_channel_number`.
- `channelNumberOf(name)`: assigns a number in order on first sight and writes state; reuses it if it already exists — **the number doesn't change on reconnect**.
- `nameByNumber(num)`: the reverse lookup, supporting routing by number via `to 2:` (§4).
- Numbers are also used in the `reply` prefix `**[#<num>-<name>]**` and the route-miss online list `name(#num)`.
- `state.json` also stores `offset` (the getUpdates cursor, the §4 dedup source of truth).

---

## 8. Security

- 🔴 **The bot token lives only in the daemon process**: read by the daemon from `config/secrets.yaml channels.telegram.token`. **No CC session (including any mate) ever touches the token** — they only send/receive via MCP. Credentials have a single egress. The attachment download URL is also assembled and consumed inside the daemon; the token never leaves it.
- **owner-only filter** (§4 step 1): only messages with `from.id === OWNER_ID` are deliverable, preventing prompt injection.
- **reply forced to the owner** (§5a): the daemon does not trust the `chat_id` the CC passes; it only sends to the owner DM.
- **`from_channel` injected by the daemon** (§5b): based on the session's true name, not trusting the CC's self-report, preventing forgery.
- **loopback-only**: the daemon binds `127.0.0.1`; CC↔CC never leaves the local machine.

---

## Appendix A — Key Constants (`channels/telegram/telegram-platform.ts` + `channels/core/src/` ground truth)

| Constant | Value | Use |
|---|---|---|
| `http_port` | 9877 | MCP-over-HTTP (127.0.0.1) |
| `poll_timeout` | 25s | getUpdates long-poll |
| `PER_NAME_FIFO_CAP` | 4 | per-channel session cap |
| `PROBE_INTERVAL_MS` | 5s | ping probe period |
| `PROBE_TIMEOUT_MS` | 4s | pong wait window |
| `CONSECUTIVE_FAIL_LIMIT` | 3 | half-open detection threshold |
| `PROBE_GRACE_MS` | 10s | new-session creation grace |
| `CHANNEL_FRESH_MS` | 15s | channel_alive liveness window |
| `STALE_EVICT_MS` | 60s | grace before truly evicting after half-open |
| `DOWNLOAD_TIMEOUT_MS` | 12s | attachment download hard timeout |
| `CC_LOOP_WINDOW_MS` / `CC_LOOP_MAX` | 2s / 5 | cc loop-guard warning threshold |
| `MAX_CHUNK_LIMIT` | 4096 | Telegram single-message cap / outbound chunk |

## Appendix B — `/api/status` Counters

`dispatches_total` (telegram inbound dispatch), `replies_total` / `replies_failed_total`, `route_miss_total`, `cc_dispatches_total` (CC↔CC), `probes_sent_total` / `probe_failures_total`, `probe_evicted_total`, `probe_reconnect_triggered_total` (number of half-open self-heal triggers), `poll_errors_total`, `offset`, `channels_online`, `active_owners`, `channel_numbers`, `channel_alive`, `sessions`.

## Appendix C — Starting a CC Attached to a Channel

- **`tg-ch <name> [args…]`** wrapper: a pure registration redirect — `claude mcp remove telegram-channel` (idempotent) → `claude mcp add --transport http --scope local telegram-channel "http://127.0.0.1:9877/mcp?name=<NAME>"` → `exec claude --dangerously-load-development-channels server:telegram-channel "$@"`.
  - The real flag value = `server:<MCP-server-name>` (`server:telegram-channel`); the consumer **resolves the channel name only from a registered MCP server**, not from an ephemeral `--mcp-config` (to avoid opening an extra spurious `main` session).
  - **project-local scope** (project-level `~/.claude.json`), not touching the global mcpServers / settings.json / teams config.
  - The first launch pops the dev-channels safety gate (`1. I am using this for local development`); claude enforces this gate with no bypass; a manual `tg-ch` launch requires manually choosing 1, while the `ka workshop` path passes the gate automatically (condition-based).
- **`tg-ch` concurrency limitation**: registration is a single shared value, so they must be started **sequentially** (don't run multiple tg-ch concurrently); they don't cross wires (a CC caches the MCP config at startup and a 404 reconnect returns to its own channel). True concurrent multi-channel steady-state hosting is provided by **`ka workshop`** (one window/pane per channel) — this is the prerequisite for productionizing CC↔CC.

## Appendix D — Follow-ups / TBD

- **Token ownership**: currently using "option B" — a standalone test bot `CCTelegramMcpBot` (a separate token for the daemon; the main telegram plugin is untouched, zero conflict, can be rolled out gradually). "Option A" (the daemon replaces the main bot, landing a true single-bot multi-channel setup, with main becoming the daemon's channel=main) awaits the user's decision. Note that a new daemon competing with the main plugin for getUpdates on the same token would be **mutually exclusive with a 409 Conflict**.
- CC↔CC fine-grained permission allowlist / hard rate-limiting / persistent queue: future work.
