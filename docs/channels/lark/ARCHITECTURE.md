# lark-channel Architecture Design

> v0.4.0 · 2026-05-20
> Companion docs: user manual in [`README.md`](./README.md); ops/troubleshooting in the lark-channel skill (`channels/lark/skill/SKILL.md`)

## 1. Goal & Positioning

lark-channel is a **standalone background daemon** that bridges Lark group chats and agent runtimes in both directions:

- **Inbound**: polls Lark groups for new messages sent by **the user themselves**, then dispatches them to a Claude Code MCP session or a registered Codex App Server target
- **Outbound**: Claude replies through the `reply` MCP tool; Codex replies through normalized runtime events and a CardKit stream with webhook fallback

The user sends and receives in Lark on their phone/computer; the **terminal transcript never reaches the user** — they only see explicit Claude `reply` tool output or Codex runtime replies emitted by the daemon.

## 2. Why a Standalone HTTP Daemon (not a stdio MCP)

The earliest v0.1 was a **stdio MCP server** spawned by Claude Code as a child process. Problems:
- Every Claude Code session restart/compact closes the stdio pipe → the server dies silently with no log
- Claude Code does not automatically re-spawn a dead stdio server

From v0.2 onward it became a **standalone HTTP daemon** (listening on `127.0.0.1:9876`):
- The process has ppid=1, independent of the Claude Code lifecycle; `/exit`, `/compact`, and Claude crashes don't affect it
- `flock` singleton ensures only one instance
- cron `* * * * * start.sh` checks every minute, so any death self-heals within ≤60s
- Trade-off: Claude Code only actively connects to the MCP **at session startup**, so if the daemon isn't up at that moment the connection fails (the skill handles this transition)

## 3. Data Flow

```
Lark group (user sends a message)
   │  lark-cli im +chat-messages-list polls per group (per-group interval: message group 1s / alert group 5s)
   ▼
channel-core daemon + lark-platform (@ 127.0.0.1:9876)
   │  parse routing prefix → find all sessions for that name → MCP notification (meta all-string)
   ▼  notifications/claude/channel  (over SSE stream)
Claude Code MCP client (some session)
   │  Claude calls mcp__lark-channel__reply
   ▼  POST /mcp
daemon  ──webhook POST──▶  Lark group (reply, auto-prefixed with [channel name])
```

For Codex, Workshop starts one App Server per mate on a loopback WebSocket and
registers its endpoint plus canonical thread ID through `/api/runtimes/codex`.
The daemon resumes that thread, submits `turn/start`, maps downloaded Lark images
to `localImage`, streams agent-message deltas into CardKit, and maps `/stop` to
`turn/interrupt`. App Server lifecycle remains owned by Workshop; the Lark daemon
only owns the client connection and channel routing.

For outbound Codex text, Channel separates the `[#N-name]` label from the body
with a blank line. Before CardKit rendering, the Lark adapter converts only
ordinary-prose soft breaks to explicit line breaks; it preserves paragraph and
block-Markdown structure. This normalization is not applied to plain webhook
fallback messages.

## 4. Multi-session / Named Routing Model (v0.4.0 core)

### 4.1 Concepts

- **client**: one `claude ...` process = one logical connection
- **channel name**: specified at startup via the MCP URL's `?name=<name>` (the `claude-ch <name>` wrapper script injects it), used to target on the Lark side. Default `main`
- **session**: one MCP connection established between the client and the daemon; the daemon assigns a random `session-id` (UUID)

### 4.2 Data Structures (v0.6.0 refactor)

```ts
type Session = {
  id: string            // mcp-session-id (UUID)
  server, transport
  name: string          // channel name
  createdAt: number     // Date.now() ms (for display)
  monoTs: bigint        // process.hrtime.bigint() nanosecond monotonic time (sort key, avoids Date.now ms collisions)
}

// Primary store: one FIFO list per channel name, capacity capped at 4
const PER_NAME_FIFO_CAP = 4
const byName = new Map<string, Session[]>()

// Auxiliary index: HTTP request headers carry session-id (not name), so we need id→Session to route to the right transport
// Kept strictly in sync with byName's push/shift, size ≤ sum(len of each name) ≤ PER_NAME_FIFO_CAP × number of names
const sessionsById = new Map<string, Session>()
```

**Why this structure**:
- A single authoritative store `byName`, one FIFO per name with a capacity cap, turns "unbounded accumulation" into "constant bounded" (7 names × 4 = at most 28 sessions, versus v0.5.x accumulating 2482 over several days).
- `sessionsById` is only a reverse index, required for HTTP routing (request headers carry the id), not the source of truth for identity/delivery.
- "owner" = `byName[name][length-1]` (the newest), used only for display and numbering, and **does not participate in delivery selection**.

### 4.3 Delivery Model (v0.6.0: send to all same-named sessions, parallel + timeout, FIFO auto-cleanup)

- New session `init` → `addSession()`: push to `byName[name]`, sync into `sessionsById`; if the list length > 4, **shift out the oldest** (also removing it from sessionsById and closing its transport). **FIFO automatically controls capacity, no active liveness-cleanup needed.**
- On delivery, iterate the entire `byName[targetName]` list (parallel + per-send timeout); the consumer session is guaranteed to receive it; the stale ones (no consumer) silently discard.
- Keeping 4 sessions ≈ 2 reconnects, **tolerating the consumer being bound to the previous reconnect's session** (after a daemon restart, the client self-heals via 404 into a new session, but the consumer may still be on the previous one).
- We do not proactively close old sessions pushed out of the FIFO (they've been superseded by newer ones and naturally lose consumer value); for ms-granularity simultaneous inits, the `monoTs` (nanosecond) sort guarantees uniqueness.
- `transport.onclose` triggers `removeSession()` for bidirectional cleanup.

### 4.4 "1 client opens 2 sessions" → must deliver to all same-named sessions (key correction)

Testing shows Claude Code opens **two MCP connections from a single process** to the daemon: ① the tool client (calls reply, answers ping) ② the `--dangerously-load-development-channels` **notification consumer** (one-way listener, does not answer ping). Both register under the same name.

- **The consumer is not necessarily the owner** (newest). The early "owner-only delivery" would deliver to the tool client's session → **the consumer never receives → it never surfaces** (the big bug in v0.5.0~v0.5.2).
- Correct approach: **deliver to all same-named sessions**, so the consumer is guaranteed to receive it; the rest (no consumer) silently discard → it surfaces exactly once.
- Delivery must be **parallel + per-send timeout** (`Promise.allSettled` + 5s `Promise.race`); otherwise a half-dead session's `notification()` awaiting will block the live consumer behind it (head-of-line).

🔴 **4.5 notification meta MUST be all-string (the #1 iron rule)**
Every field in `notifications/claude/channel`'s `params.meta` **must be a string**. Putting any **number/object** field (the historical culprit: the `channel_number` number) → Claude Code's dev-channels consumer **silently drops the entire notification** → "dispatched but never surfaces". To carry a number, use `String(n)`.

## 5. Message Deduplication (fixing "multiple messages in the same minute lost")

Lark's `create_time` has **minute-level precision** (e.g. `2026-05-20 22:51`); multiple messages in the same minute carry identical timestamps.

- The old logic `t <= lastSeenMs` would filter out all subsequent same-minute messages → lost messages
- Current logic:
  1. Time comparison uses `t < lastSeenMs` (keeps same-minute messages)
  2. **message_id-level dedup**: `state.recent_msg_ids[chatId]` keeps the most recent 100 already-delivered message_ids; skip on a hit
  3. **Record + persist before delivery** (`rememberMsgId` + `saveState` run before dispatch) → even if delivery/session churn has problems, the same message is never re-delivered

## 6. Liveness Probe: write-only keepalive (v0.6.2, the final scheme after v0.5's ping-kills-consumer-deletion saga)

**Evolution history**:
- **v0.4 ping (deleted)**: send an MCP `ping` request every 30s → the notification consumer is a **one-way listener that doesn't answer ping** → guaranteed timeout → culled → notifications can never reach the consumer again → never surfaces. **NEVER add request-style ping back.**
- **v0.5.2~v0.6.0**: no active probing, relying only on `transport.onclose`. Problem: a client that exits non-gracefully (window force-close, kill -9) doesn't trigger onclose → "ghost" sessions accumulate in the map.
- **v0.6.2 current**: write-only keepalive, which catches hard disconnects while not falsely killing the consumer.

```ts
const PROBE_INTERVAL_MS = 5000
const CONSECUTIVE_FAIL_LIMIT = 3
const PROBE_PROTECT_TAIL = 2  // the newest 2 per name are never evicted
setInterval(async () => {
  for (const [name, list] of byName) {
    for (let i = 0; i < list.length; i++) {
      const sess = list[i]
      const immune = i >= list.length - PROBE_PROTECT_TAIL
      try {
        await sess.server.notification({           // write-style, no response required
          method: 'notifications/claude/keepalive',
          params: { t: Date.now() },
        })
        sess.consecutiveFails = 0
      } catch (e) {
        sess.consecutiveFails++
        if (!immune && sess.consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) removeSession(sess.id)
      }
    }
  }
}, PROBE_INTERVAL_MS)
```

**Core mechanism**:
- Every 5s, send a `notification` to **all** sessions (method `notifications/claude/keepalive`; Claude Code ignores it on receipt, **does not surface**).
- **Write-style** (`transport.send` to the SSE socket, no waiting for response) → won't falsely kill because the consumer doesn't answer a request.
- A write that throws = TCP already FIN/RST → `consecutiveFails++`; a successful write → counter reset to zero.
- **3 strikes (3 consecutive failures) before evict** (non-transient); **the newest PROBE_PROTECT_TAIL=2 per name are never evicted** (protecting the current consumer + tool client, so even a misjudgment loses nothing).
- The `channel_alive[name]` field: **that name has at least 1 session probing successfully** (or is too new to have completed a probe round) → alive.

### 6.1 Known Limitation: soft-dead can't be caught

**When the process is dead but the OS-level TCP hasn't FIN/RST yet** (shortly after a window close, or in some half-open connection states), `res.write()` stuffing data into the OS socket buffer can still return success → the probe sees it as alive → **not evicted**. Such "ghosts" are pushed out by the FIFO (cap=4) when a new connection arrives, or cleaned up by a daemon restart.

We previously considered hardening: using a request-with-response probe for old sessions outside the top-2 (top-2 still write-style). **Deliberately not implemented** — limited impact (delivery is parallel + timeout, doesn't block live consumers), and the added complexity isn't worth it. If the problem worsens someday, this is the remediation direction.

## 7. Session Invalidation Self-heal (404 → re-initialize)

After a daemon restart, an old client comes in with a stale session-id:
- The `/mcp` handler finds that session-id isn't in `sessions` → **returns HTTP 404**
- Per the MCP spec, on receiving a 404 the client treats the session as invalid → re-runs the initialize handshake → new session
- If instead of returning 404 it took the "create new session" branch, it would report `Server not initialized` and the client wouldn't self-heal

> ⚠️ Important lesson: **Repeatedly restarting the daemon interrupts the client's SSE notification stream**. The `--dangerously-load-development-channels` consumer is bound at Claude startup; a daemon restart makes the client re-init into a new session, but the dev-channel consumer may still be bound to the old (dead) session → messages get delivered to a session nobody consumes. **Solution: after restarting the daemon, restart the corresponding client once** (to rebind the consumer). Avoid this in daily use by not restarting the daemon.

## 8. Watermark & Offline Replay

- One `last_seen_msg_time` watermark per group
- When `sessions.size === 0` (no sessions at all), **the watermark is not advanced** → messages during Claude's offline period are replayed after reconnect
- With sessions present, advance normally + record message_id

## 9. Routing Syntax (Lark side)

| Form | Behavior |
|---|---|
| `content` (no prefix) | **Sticky** → delivered to this chat's last single target (`last_target_by_chat`, see below) |
| `to <name>: content` | Delivered only to `<name>`'s owner (**colon required**, `:` immediately follows the name/content) |
| `to all: content` | Broadcast to all channels' owners |
| `to <nonexistent>: content` | daemon replies `⚠️ channel "<name>" is offline` + lists online channels |

- Case-insensitive
- Channel name charset is only `a-z0-9_-` (`claude-ch` strips other characters like `.`: `weex.repo` → `weexrepo`)
- **Sticky routing**: a no-prefix message reuses the last **single** target the chat routed to. The decision is the shared pure `applyStickyRouting` (`channels/core/src/routing.ts`, also used by telegram): only an explicit single, non-`all` target is remembered; multi-target / `to all` do not stick. Because a lark daemon serves many chats, the remembered value is keyed **per chat** (`last_target_by_chat`), unlike telegram's single global `last_target`. No remembered target (chat's first message) or it being offline → daemon prompts the owner to pick a channel + online list (no silent default to `main`). This same per-chat store also backs attachment targeting (it replaced the old separate `attachTarget`).

## 10. Key Invariants (must preserve when changing code)

1. **Singleton**: flock guarantees only one daemon
2. **Primary store indexed by name** (`byName: Map<name, Session[]>` FIFO cap=4), auxiliary `sessionsById` only for HTTP routing (request headers carry id); "owner" is for display only
3. **Record message_id and persist before delivery** — the single source of truth for dedup
4. 🔴 **notification `params.meta` must be all-string** — any number/object field makes the consumer silently drop the entire notification
5. **Deliver to all same-named sessions, parallel + per-send timeout** — hits the consumer, no duplicates, not blocked by half-dead sessions
6. **Probe only with write-only `notification`** (`notifications/claude/keepalive`, no response required) + 3-strike + newest 2 per name never evicted — **NEVER** use request-style ping (a one-way consumer that doesn't answer gets falsely killed)
7. **Don't proactively close a superseded old owner** — otherwise 404→reconnect→flap
8. **Return 404 for unknown session-id** — client self-heal depends on it
9. **Only deliver the user's own messages** (`self_open_id` filter) — prevents prompt injection from other group members

## 11. Version History

- **v0.6.2 (2026-05-25)** — **Probing re-added, but write-style + top-2 protection**: `notifications/claude/keepalive` write-only, runs every 5s, evict only after 3 strikes, newest 2 per name never evicted. Plugs v0.6.0's "ghost session" gap. Known limitation: can't probe when the process is dead but OS-level TCP hasn't FIN'd (write into buffer still succeeds) → backstopped by FIFO. Added `probe_evicted_total / probes_sent_total / probe_failures_total / channel_alive` fields. See §6.
- **v0.6.0 (2026-05-25)** — Session storage refactor: single Map `byName: Map<name, Session[]>` + **per-name FIFO of 4** (`PER_NAME_FIFO_CAP`), the oldest pushed out by new connections. Fully resolves session accumulation bloat (2482 → ≤ 7×4 = 28). Sort uses `process.hrtime.bigint()` nanosecond monotonic time (avoids Date.now same-ms collisions). Delivery is still all same-named sessions parallel + timeout; owner = end of list. Auxiliary `sessionsById` index only for HTTP request → transport routing.
- **v0.5.3 (2026-05-21)** — 🔴 Fixed the big "dispatched but doesn't surface" bug: **meta must be all-string** (removed numeric `channel_number`); **deleted ping probing** (falsely killed the consumer); **delivery changed back to all same-named sessions + parallel timeout** (consumer isn't necessarily the owner); lenient routing prefix (`to`/`2`, optional colon) + stable channel numbers (`to 1:`); **per-group poll** (Example Group A 1s / Example Group B 5s)
- **v0.4.0 (2026-05-20)** — named channel + owner model, `to <name>:` targeting + `to all:` broadcast, message_id dedup, 404 self-heal, (ping probing — deleted in v0.5.2), reply auto `[name]` prefix, `claude-ch` wrapper script
- v0.2 (2026-05-11) — standalone HTTP daemon, decoupled from the Claude Code lifecycle, cron-supervised
- v0.1 (2026-05-07) — original stdio MCP child process (deprecated)
