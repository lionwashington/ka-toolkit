# lark-channel

Standalone daemon that bridges Lark group chats ↔ Claude Code via MCP HTTP transport.

> **Architecture design** is in [`ARCHITECTURE.md`](./ARCHITECTURE.md); ops/troubleshooting in [`SKILL.md`](../.claude/skills/lark-channel/SKILL.md).

## TL;DR

```
Lark (group msg)
   ↓ lark-cli poll (per-group: message group 1s / alert group 5s)
~/.lark-channel/server.ts  (daemon @ 127.0.0.1:9876)
   ↓ MCP notification → all same-named sessions   ↓ webhook bot POST
Claude Code MCP client (named channel)  ←→   Lark group (reply, auto-prefixed with [name])
```

- **Independent from Claude Code lifecycle.** Daemon ppid=1, survives `/exit` / `/compact` / Claude crash.
- **Singleton.** `flock -n` on `.daemon.lock`. Second instance exits cleanly.
- **Auto-revive.** Cron `* * * * * start.sh` brings it back within 1 min of any death.
- **Named channel + numbers.** Each Claude process starts with `?name=<name>`; `to <name>:` / `to <number>:` targets on the Lark side; lenient prefix (`to`/`2`, optional colon).
- **Deliver to all same-named sessions + parallel timeout.** A single client opens two connections (tool + consumer), the consumer isn't necessarily the owner, so deliver to all same-named sessions; parallel + timeout prevents head-of-line.
- 🔴 **notification meta must be all-string.** A numeric field makes Claude Code silently drop the entire notification (historical culprit `channel_number`).
- **Dedup + self-heal.** message_id-level dedup (fixes the same-minute multiple-messages loss); after a daemon restart the client auto re-handshakes via 404.
- **Write-style keepalive probing (v0.6.2)**: a write-only `notification` round every 5s (no response required), evict only after 3 strikes, the newest 2 per name never evicted. **NEVER** use request-style ping (it falsely kills the one-way consumer).
- **Watermark gated on sessions.** When there are no sessions, the watermark doesn't advance — messages during Claude's offline period are replayed after reconnect.

## Quickstart (launch a named session)

```bash
# Use the claude-ch wrapper script: the first argument is the channel name, the rest pass through verbatim to claude
claude-ch main  --dangerously-skip-permissions --dangerously-load-development-channels server:lark-channel
claude-ch audit --dangerously-skip-permissions --dangerously-load-development-channels server:lark-channel
claude-ch weexrepo --dangerously-skip-permissions ...
```

What `claude-ch` (at `~/.local/bin/claude-ch`) does: sanitizes the channel name to `a-z0-9_-`, generates a temporary MCP config that changes the URL to `…/mcp?name=<name>`, then `exec claude --mcp-config <temp config> [remaining args]`.

### Lark-side routing syntax

| Form | Behavior |
|---|---|
| `content` | Default → `main` |
| `to <name>: content` / `to <name> content` / `2<name>` / `2 <name> content` | Targeted to `<name>` (prefix `to`/`2`, spaces flexible, colon optional) |
| `to 1:` / `to2:` / `to 3` / `2 1: content` | Targeted by **number** (numbers in `/api/status`'s `channel_numbers`) |
| `to all: content` / `2 all content` | Broadcast to all online channels |
| `to <nonexistent>: content` | With explicit colon → daemon replies "offline" + lists online channels (#numbers) |

> Since v0.5.3 the prefix is lenient (`to`/`2`, colon optional); **without a colon, routing only happens if the target matches an online channel (name or number)**, otherwise it's treated as a plain message and the full text goes to main (so `tomorrow…`/`2 weeks…` won't be misrouted). Channel names can't contain characters like `.` (`weex.repo`→`weexrepo`).

## Files

| Path | Purpose |
|---|---|
| `server.ts` | Daemon source (Node + TS via `--experimental-strip-types`) |
| `config.json` | Self open_id, polling interval, page size, http_host/port, group→webhook mapping |
| `state.json` | Per-group `last_seen_msg_time` watermarks (persistent) |
| `daemon.sh` | flock-wrapped foreground runner. **Don't call directly** — use `start.sh` |
| `start.sh` | Idempotent launcher. Probe → defensive orphan cleanup → background fork → wait 5s for up |
| `status.sh` | Health check. `exit 0 + JSON` if up, `exit 1` if down |
| `stop.sh` | Graceful shutdown via `POST /api/shutdown` |
| `channel.log` | Daemon's own log (lifecycle, dispatches, errors) |
| `daemon.stdout.log` | stdout/stderr from background launch (set up by `start.sh`) |
| `supervisor.log` | cron `start.sh` runs (mostly "already running" noise) |
| `daemon.pid` | PID of current daemon (rewritten each boot) |
| `.daemon.lock` | flock target |
| `node_modules/` | npm deps (Express + MCP SDK + spawn-tree friends) |
| `README.md` | This file |

## HTTP API

Listens on `127.0.0.1:9876` (loopback only). DNS rebinding protection auto-applied for localhost.

| Method | Path | Purpose |
|---|---|---|
| `POST / GET / DELETE` | `/mcp` | MCP Streamable HTTP transport. Claude Code's MCP client lives here. Session-aware (per-Claude-process). |
| `GET` | `/api/status` | JSON: `{pid, uptime_seconds, mcp_sessions, channels_online, active_owners, sessions[], poll_errors_total, dispatches_total, replies_total, keepalive_culled_total, route_miss_total, last_poll_at, watermarks}` |
| `GET` | `/api/metrics` | Prometheus exposition format (text/plain) |
| `POST` | `/api/shutdown` | Graceful exit (loopback only) |

The `active_owners` field = `{channel name: first 8 chars of session-id}`, showing which session each channel currently belongs to.

## Claude Code integration

The default (unnamed) entry is registered in `~/.claude.json` user scope:

```json
"lark-channel": {
  "type": "http",
  "url": "http://127.0.0.1:9876/mcp"
}
```

This default entry has no `?name=`, so after connecting the channel name is `main`. To use a different name, use `claude-ch <name>` (which uses `--mcp-config` to override the URL to `…/mcp?name=<name>`).

Once Claude Code starts a new session, it auto-connects to the daemon. The daemon's `reply` tool appears as `mcp__lark-channel__reply` in Claude's tool list, and incoming Lark messages are pushed in as `notifications/claude/channel` events (params include `meta.channel_name` / `meta.routed_target`).

Lifecycle management (start/stop/status/troubleshoot) is documented in the **lark-channel skill** at `~/.claude/skills/lark-channel/SKILL.md`. Claude will invoke that skill when the user reports connectivity issues.

## Cron supervisor

```
* * * * * ~/.lark-channel/start.sh >> ~/.lark-channel/supervisor.log 2>&1
```

Every minute, `start.sh` is invoked:
- If daemon alive → no-op (`✓ already running`)
- If daemon dead → re-launch via double-fork

This means **max ~60s outage after any death**.

## Common ops

```bash
# Status
~/.lark-channel/status.sh | jq

# Start (idempotent)
~/.lark-channel/start.sh

# Graceful stop
~/.lark-channel/stop.sh

# Force restart
~/.lark-channel/stop.sh && sleep 1 && ~/.lark-channel/start.sh

# Live log tail
tail -f ~/.lark-channel/channel.log

# Recent dispatches
grep "dispatch" ~/.lark-channel/channel.log | tail -10

# Recent errors
grep -E "error|fail|exception|uncaught" ~/.lark-channel/channel.log | tail -10

# Manually rewind watermark (replay missed messages)
# Edit ~/.lark-channel/state.json, set last_seen_msg_time[chat_id] to earlier ISO timestamp
# Daemon picks up on next poll (no restart needed)

# Curl-driven smoke test for /mcp
curl -i http://127.0.0.1:9876/api/status
```

## Adding a new Lark group

1. Edit `~/.lark-channel/config.json` → `groups`:
   ```json
   "oc_NEW_CHAT_ID": {
     "name": "Display Name",
     "webhook_url": "https://open.larksuite.com/open-apis/bot/v2/hook/..."
   }
   ```
2. Restart: `~/.lark-channel/stop.sh && ~/.lark-channel/start.sh`
3. Daemon anchors watermark at NOW for the new group (no replay of old history).

## Debug checklist (when something stops working)

1. **`status.sh` exit 1**: daemon dead. Check `tail -50 ~/.lark-channel/channel.log` for crash trace. Re-launch via `start.sh`.
2. **`mcp_sessions: 0`**: Claude Code not connected. Restart Claude Code.
3. **`poll_errors_total` climbs**: Lark API issue. `grep "fetch failed" channel.log | tail` for cause.
4. **Watermark doesn't advance**: `mcp_sessions: 0` is the gating reason (intentional — replay on Claude reconnect). If you genuinely want to skip ahead while no client connected, manually edit `state.json`.
5. **HTTP port 9876 occupied**: `ss -tlnp | grep 9876` and kill the orphan.
6. **Two daemons running somehow**: shouldn't happen due to flock, but if it does: `ps -ef | grep server.ts`, kill the one without the flock-wrapped parent.

## Limitations / known issues

- **MCP tool hot-load**: Claude Code only connects to MCP servers at session start. If daemon was down when Claude started, no MCP connection until Claude restart.
- **Lark API rate limits**: heavy polling may hit `99991400 request trigger frequency limit`. Per-group intervals: message group 1s, alert group 5s. If 99991400 appears, raise the busy group's `poll_interval_seconds` in config.json.
- **Single user assumption**: `self_open_id` filter — only the user's own typed messages trigger dispatch. Bot messages and other users' messages are ignored (prevents prompt injection from other chat members).
- **Webhook delivery is fire-and-forget**: if Lark webhook returns non-zero, daemon logs but doesn't retry. Out-of-order edge cases at message edit time are not handled.

## Version history

- **v0.6.2 (2026-05-25)** — Probing re-added: write-style `notifications/claude/keepalive`, runs every 5s, evict only after 3 strikes, top-2 per name never evicted (protects the consumer). Added `probe_evicted_total / probes_sent_total / probe_failures_total / channel_alive`. Known limitation: can't probe when the process is dead but OS-level TCP hasn't FIN'd → backstopped by FIFO.
- **v0.6.0 (2026-05-25)** — Session storage refactor: single Map `byName: Map<name, Session[]>` + per-name FIFO of 4; `monoTs` (hrtime nanoseconds) ordering to avoid collisions; `sessionsById` only as an HTTP routing aid. Fully resolves session accumulation bloat.
- **v0.5.3 (2026-05-21)** — 🔴 Fixed the "dispatched but doesn't surface" bug: meta must be all-string (removed numeric channel_number); deleted ping probing (falsely killed the consumer); delivery changed back to all same-named sessions + parallel timeout; lenient prefix + channel numbers; per-group poll (message group 1s/alert group 5s). See [`ARCHITECTURE.md`](./ARCHITECTURE.md) §11
- **v0.4.0 (2026-05-20)** — named channel + owner model, `to <name>:` targeting + `to all:` broadcast, message_id dedup, 404 self-heal, reply auto `[name]` prefix, `claude-ch` wrapper script
- v0.2 (2026-05-11) — Standalone HTTP daemon, decoupled from Claude Code, cron-supervised
- v0.1 (2026-05-07) — Original stdio MCP subprocess (deprecated, see ARCHITECTURE.md §2)
