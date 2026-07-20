---
name: lark-channel
description: Manage the standalone lark-channel daemon — a process that polls Lark groups and routes messages to Claude Code over MCP or to Workshop-managed Codex App Server targets, then posts replies through webhook bots or CardKit. Use this skill for daemon lifecycle, named-channel routing, and Lark↔agent-runtime connectivity troubleshooting. Do NOT use this skill for normal Lark API operations — those are in lark-im / lark-drive / etc.
---

# lark-channel daemon

A **standalone background daemon** (decoupled from Claude Code lifecycle) that:
- Polls Lark groups on **per-group intervals** (`Example Group A` 1s, `Example Group B` 5s)
- Filters for messages from the user (`self_open_id`)
- Routes them to all Claude MCP sessions of the target name or to its registered Codex target
- Accepts replies via webhook bots or CardKit, auto-prefixed with `[#number-name]`
- Drives registered Codex threads through App Server and streams their replies through CardKit with webhook fallback

The source documentation is in `docs/channels/lark/{ARCHITECTURE,README}.md`.

**Key invariants (v0.5.3)**:
- Only ONE daemon instance runs at a time (`flock` on `~/.knowledge-assistant/channels/lark-daemon/.daemon.lock`).
- **(v0.6.0)** Primary store `byName: Map<name, Session[]>` — per-name FIFO, cap = 4 (`PER_NAME_FIFO_CAP`); when the oldest gets pushed out, its connection is closed and it's removed from the `sessionsById` index in sync. Fully resolves session accumulation bloat (v0.5.x accumulated 2482 over several days → now at most 7×4 = 28).
- Auxiliary `sessionsById: Map<id, Session>` — only for HTTP request → transport routing (request headers carry the id, not the name).
- `monoTs: bigint` (hrtime nanoseconds) used for monotonic-time ordering, avoiding `Date.now()` ms-level collisions.
- "owner" = end of list (newest), used only for numbering/display, not for delivery selection.
- **Delivery goes to ALL sessions sharing the target channel name**, in parallel with a per-send timeout (the dev-channels consumer may not be the owner; owner-only delivery silently fails to surface).
- 🔴 **notification `params.meta` MUST be all-string** — a numeric field (e.g. the old `channel_number`) makes Claude Code's dev-channels consumer silently drop the whole notification. This was the great "dispatched but never surfaced" bug.
- **Write-only keepalive (v0.6.2)** — every 5s, send a fire-and-forget `notification` (method `notifications/claude/keepalive`, Claude Code ignores it). 3 consecutive write failures evict; **the newest 2 sessions per name are NEVER evicted** (protects the consumer + tool client). NEVER use `request`-style `ping` — single-direction consumer won't answer and gets killed.
- message_id-level dedup; unknown session-id → 404 (client self-heals by re-initializing).
- Lenient routing prefix (`to`/`2`, optional colon) + stable per-name channel numbers (`to 1:`).

## ⚠️ The Most Important Ops Commandment: Don't Casually Restart the daemon

**Restarting the daemon interrupts the SSE notification stream of connected clients.** The `--dangerously-load-development-channels` channel consumer is bound to the MCP session that existed at Claude startup; a daemon restart forces the client to re-init into a new session, but the consumer may still be bound to the old (dead) session → messages get delivered to a session nobody consumes, presenting as "the daemon clearly dispatched, but the conversation never receives it".
- **When you must restart after changing daemon source**: deploy it with `./install.sh --only daemon`. Claude MCP clients may need one restart to rebind their consumer; Workshop-managed Codex targets re-register automatically.
- For routine troubleshooting, **prefer methods that don't require a restart** (check status, check the log, clear state).

## Layout

```
~/.knowledge-assistant/channels/lark-daemon/
├── daemon.mjs            # deployed self-contained daemon bundle
├── state.json            # last_seen watermark per group
├── daemon.sh             # foreground runner (flock-protected) — DON'T run directly
├── start.sh              # idempotent starter — USE THIS to launch
├── status.sh             # health check (exit 0 if alive, 1 if dead)
├── stop.sh               # graceful shutdown via /api/shutdown
├── channel.log           # daemon's own log (lifecycle, dispatches, /mcp methods, errors)
├── daemon.stdout.log     # stdout/stderr from background launch
├── daemon.pid            # pid of running daemon
└── .daemon.lock          # flock for singleton

~/.knowledge-assistant/config/
├── config.yaml           # non-secret channel kind, port, polling configuration
└── secrets.yaml          # self_open_id, chat IDs, webhook URLs (mode 600)

~/.local/bin/claude-ch    # wrapper script to launch a named session
```

## How Claude integrates

Default (unnamed) entry in `~/.claude.json` (user scope) → connects as channel `main`:

```json
"lark-channel": {
  "type": "http",
  "url": "http://127.0.0.1:9876/mcp"
}
```

When Claude Code starts, it connects to `http://127.0.0.1:9876/mcp`. If the daemon is running, `mcp__lark-channel__reply` + the channel notification subscription become available. If the daemon is down, MCP connection fails silently — **this skill is how you bring it back up**.

## Named channel + routing (v0.4.0)

### Codex targets

Codex targets are not MCP sessions and are not configured under `channels.lark`.
`ka workshop` starts one loopback App Server per `runtime: codex` mate and registers
its endpoint plus canonical thread ID with the active daemon. Inspect
`/api/status.runtime_targets` to verify registration. `/stop` interrupts the active
turn; images are passed as `localImage`; CardKit creation or update failures fall
back to the configured group webhook. Restart or repair the Workshop mate when a
Codex target is absent or `alive: false`.

### Launch a named session — `claude-ch`

```bash
claude-ch <name> [...args passed through verbatim to claude]
# e.g.:
claude-ch main  --dangerously-skip-permissions --dangerously-load-development-channels server:lark-channel
claude-ch audit --dangerously-skip-permissions --dangerously-load-development-channels server:lark-channel
```

`~/.local/bin/claude-ch`: sanitizes the channel name to `a-z0-9_-` → generates a temporary MCP config that changes the URL to `…/mcp?name=<name>` → `exec claude --mcp-config <temp> [remaining args]`.

### Lark-side routing syntax (v0.5.0 lenient prefix + numbers)

| Form | Behavior |
|---|---|
| `content` | Sticky → the chat's last explicit single target; if none is available, ask the user to select a target |
| `to <name>: content` / `to <name> content` / `2<name>` / `2 <name> content` | Delivered to `<name>` (prefix `to`/`2`, spaces flexible, colon optional) |
| `to 1:` / `to2:` / `to 3` / `2 1: content` | Deliver by **number** (numbers in `channel_numbers`) |
| `to all: content` / `2 all content` | Broadcast to all online channels |
| `to <nonexistent>: content` | With explicit colon → daemon replies "offline" + lists online channels (#numbers) |

**No-colon anti-misroute rule**: with a colon = explicit routing (a miss returns a hint); without a colon = route only if the target matches an **online** channel (name or number), otherwise treat the full text as a sticky plain message (so `tomorrow ...` / `2 weeks later` won't be misrouted).

**Numbers**: `state.channel_numbers` (name→number) is persisted, assigned on first sight, retained across disconnect, reused on reconnect, so `to 2:` is always the same channel. `channelNumberOf()` / `nameByNumber()`.

### Delivery model (v0.5.3: send to all same-named sessions, parallel + timeout)

- (v0.6.0) Data structure: `byName: Map<name, Session[]>`, one FIFO list per name (cap=4); "owner" = last element of the list, used only for numbering/list display, not for delivery selection.
- **Delivery goes to all same-named sessions** (not just the owner) — the session Claude's dev-channel notification consumer is bound to isn't necessarily the owner, so owner-only delivery may not surface. Sending to all same-named → the consumer one receives it, the rest silently discard → exactly once.
- **Parallel `Promise.allSettled` + 5s per-send timeout** — prevents a half-dead session's `notification()` from blocking the await and stalling the live consumer behind it (head-of-line).
- 🔴 **notification `params.meta` must be all strings**. A numeric field makes Claude Code silently drop the entire notification. To carry a number, use `String(n)`.
- **(v0.6.2) write-style keepalive probing**: every 5s, send a write-only `notification` to all sessions (method `notifications/claude/keepalive`, Claude Code ignores it on receipt); evict only after 3 consecutive write failures, **the newest 2 per name are never evicted** (protecting the consumer + tool client). `/api/status` adds the `channel_alive` field. **NEVER** use request-style ping (a one-way consumer that doesn't answer → falsely killed; see §rationale).
- Known limitation: when the process is dead but OS-level TCP hasn't FIN'd, a write into the buffer still succeeds, so the probe sees it as alive (soft-dead) → backstopped by the FIFO (cap=4) being pushed out when a new connection arrives.
- `curl -s localhost:9876/api/status | jq '.active_owners, .channel_numbers'`.

## Trigger phrases

Invoke this skill when the user says any of:

- "restart lark-channel" / "start lark-channel"
- "lark won't connect" / "lark-channel is down"
- "check the lark daemon status"
- "messages in the Lark group get no response" / "why isn't Lark pushing through"
- Or when you yourself notice `mcp__lark-channel__reply` is missing from your tool list

## Decision tree

### Step 1 — Check status

```bash
~/.knowledge-assistant/channels/lark-daemon/status.sh
```

- Exit 0 + JSON → daemon alive, problem is elsewhere (see Step 3)
- Exit 1 → daemon dead, go to Step 2

### Step 2 — Start daemon if dead

```bash
~/.knowledge-assistant/channels/lark-daemon/start.sh
```

This is **idempotent and safe to run anytime**:
- If already up: prints `✓ already running` + status JSON, exits 0
- If down: double-forks into background, waits up to 5s for HTTP to come up, prints status, exits 0
- If failed to start within 5s: prints `✗ failed to start`, tails the launch log, exits 1

After successful start, tell the user: **"the daemon is up, but you need to restart the Claude Code session for the MCP HTTP connection to be re-established"** — Claude Code only initiates MCP connections at session start, not on demand.

### Step 3 — If daemon is alive but messages still don't flow

Common causes:

| Symptom | Check | Fix |
|---|---|---|
| `mcp__lark-channel__reply` not in tool list | Session predates daemon start | Restart Claude Code (`/exit` + re-launch) |
| `mcp_sessions: 0` in status | No client connected | Restart Claude Code |
| **Message reached a channel but the corresponding session didn't receive it** | `reply` can send (POST works) but the notification (SSE) is broken — most likely because the **daemon was recently restarted**, and the dev-channel consumer is bound to an old dead session | **Restart that client** (`/exit` + re-run `claude-ch <name> …`). A `/mcp GET` in the log indicates the SSE stream is established |
| **User says "to xxx didn't route"** | Missing the English colon, or the name contains illegal characters that got sanitized | See "two high-frequency user pitfalls" above; `jq .active_owners` to see the real online channel names |
| `route_miss_total` grows | User used a nonexistent channel name | daemon already replied with a hint to Lark; double-check `active_owners` |
| **Message dispatched but doesn't surface in the conversation** | 🔴 Top suspect: a **non-string field** in the notification meta (silently dropped by Claude Code) | Check whether the dispatch's `params.meta` is all-string; the historical culprit was the numeric `channel_number` |
| Suspected double-delivery across multiple same-named sessions | Multiple same-named sessions each have an independent consumer (rare, usually 2 clients with the same name) | Normally only 1 consumer surfaces; use different names at startup to avoid it |
| `poll_errors_total > 10` | Lark API issue | `tail -30 ~/.knowledge-assistant/channels/lark-daemon/channel.log` for `fetch failed` |
| Recent Lark messages missing | Watermark advanced past them | Check `watermarks`; edit `~/.knowledge-assistant/channels/lark-daemon/state.json` to roll it back (note `recent_msg_ids` also dedups) |

## Diagnostic commands

```bash
# Live log tail
tail -f ~/.knowledge-assistant/channels/lark-daemon/channel.log

# Recent activity / errors
grep -E "error|fail|exception|dispatch" ~/.knowledge-assistant/channels/lark-daemon/channel.log | tail -20

# Check what's listening on port 9876
ss -tlnp 2>/dev/null | grep 9876

# Process tree
ps -ef | grep -E "node.*lark-daemon/daemon.mjs|flock.*daemon.lock" | grep -v grep

# Who holds the flock
fuser ~/.knowledge-assistant/channels/lark-daemon/.daemon.lock

# Force-restart (kill and re-launch)
~/.knowledge-assistant/channels/lark-daemon/stop.sh && sleep 1 && ~/.knowledge-assistant/channels/lark-daemon/start.sh
```

## Architecture rationale (FYI)

Full design is in **`docs/channels/lark/ARCHITECTURE.md`**. Key points:

- **Why a standalone HTTP daemon**: the old version was a stdio MCP child process spawned by Claude Code; a session restart/compact closes stdin → the server dies silently and isn't auto-respawned. Now an independent process with ppid=1, cron checks every minute, self-heals within ≤60s.
- **Why deliver to all same-named sessions (not owner-only)**: a single Claude process opens **two** connections — the tool client + the `--dangerously-load-development-channels` notification consumer. The consumer isn't necessarily the owner, so owner-only delivery may not surface. Delivering to all same-named → the consumer one receives it.
- **Why parallel + timeout delivery**: with sequential await, a half-dead session ahead would stall and block the live consumer behind it (head-of-line).
- 🔴 **Why meta must be all-string**: Claude Code's channel consumer **silently drops the entire notification** for non-string fields in meta (historical culprit: the numeric `channel_number`).
- **Why probe only with write-only `notification` (not request)**: the consumer is a one-way listener and won't answer a server-initiated `ping` request → a request probe would surely kill it falsely. Switching to write-only `notification` (`notifications/claude/keepalive`): only checks whether the write throws (whether TCP is still connected), requires no response, so the consumer won't be misjudged. `v0.6.2` re-added probing, 3-strike + newest 2 per name never evicted.
- **soft-dead can't be caught**: when the process is dead but OS-level TCP hasn't FIN'd, a write into the buffer still succeeds → the probe sees it as alive → backstopped by the FIFO (cap=4).
- **Why unknown session-id returns 404**: lets the client self-heal by re-handshaking, otherwise it reports `Server not initialized`.
- **per-group poll**: each group has its own `poll_interval_seconds` (Example Group A 1s, Example Group B 5s); the base tick runs at the global interval, each group pulls only when due.

## What NOT to do

- ❌ **Don't casually restart the daemon** (see the commandment at the top) — it breaks the SSE notification stream of connected clients and forces restarting the clients too
- ❌ Don't run `daemon.sh` directly — use `start.sh`
- ❌ Don't start a second daemon by editing config — flock prevents it
- ❌ Don't `kill -9` unless graceful shutdown failed — use `stop.sh` first
- ❌ **Don't force-close a superseded old owner's connection** (at the code level) — it triggers 404→reconnect→flap
- ❌ 🔴 **Don't put any non-string field (number/object) into the notification `params.meta`** — Claude Code will silently drop the entire notification. To carry a number, use `String(n)`
- ❌ **Don't use `request`-style ping for probing** — it falsely kills the consumer that doesn't answer ping (v0.6.2 uses write-only `notification` for probing; read §rationale before changing it)
- ❌ Don't modify `state.json` casually — only rolling back `last_seen_msg_time` together with `recent_msg_ids` truly replays
- ❌ Don't add to systemd/PM2 — cron supervisor is intentional (WSL, no root)
