# lark-channel

Standalone background daemon that bridges **Lark group chats** with multiple agent-runtime sessions in both directions.
The owner routes group messages to Claude Code or Codex targets with `to <name>: content`; replies are auto-prefixed with `[#<number>-<name>]`.
The webhook token lives only at this single daemon exit; agent-runtime processes never receive it.

> **Architecture design** is in [`ARCHITECTURE.md`](./ARCHITECTURE.md); ops/troubleshooting in the lark-channel skill (`channels/lark/skill/SKILL.md`).

```
Lark (group msg)
   │ ① lark-cli poll (per-group: base 1s, per-group override e.g. alert group 5s)
   ▼
lark-channel daemon  (node @127.0.0.1:9876)
   │ ② MCP notification or App Server turn   │ ③ webhook/CardKit
   ▼                                            ▼
Claude Code / Codex runtime targets             Lark group (reply, auto-prefixed [#n-name])
```

- **Independent daemon lifecycle.** The daemon survives runtime exits and crashes. Claude MCP clients reconnect through their normal MCP lifecycle; Workshop re-registers live Codex App Servers.
- **Singleton.** `flock -n` on `.daemon.lock` (Linux); else the fixed HTTP port enforces it (`EADDRINUSE` → clean exit).
- **Auto-revive.** Cron `* * * * * start.sh` brings it back within ~60s of any death.
- **Named channel + numbers.** Claude processes connect with `?name=<name>` and Codex mates register the same logical names; `to <name>:` / `to <number>:` targets on the Lark side; lenient prefix (`to`/`2`, optional colon).
- **Deliver to all same-named sessions + parallel timeout.** A single client opens two connections (tool + consumer), the consumer isn't necessarily the owner, so deliver to all same-named sessions; parallel + timeout prevents head-of-line.
- 🔴 **notification meta must be all-string.** A numeric field makes Claude Code silently drop the entire notification (historical culprit `channel_number`).
- **Dedup + self-heal.** message_id-level dedup (fixes the same-minute multiple-messages loss); after a daemon restart the client auto re-handshakes via 404 / re-adopt.
- **Write-style keepalive probing (v0.6.2)**: a write-only `notification` round every 5s (no response required), evict only after 3 strikes, the newest 2 per name never evicted. **NEVER** use request-style ping (it falsely kills the one-way consumer).
- **Watermark gated on runtime targets.** When neither Claude MCP sessions nor Codex targets are online, the watermark doesn't advance, so messages are replayed after reconnect.

## Directory

- **Source (source-of-truth, committed to git)**: `channels/lark/` (the Lark platform adapter) on top of `channels/core/` (the shared channel-core kernel).
- **Runtime directory (not in git)**: `~/.knowledge-assistant/channels/lark-daemon/` — produced by `install.sh --only lark-daemon` (or the combined `--only daemon`) as a single self-contained `daemon.mjs` esbuild bundle (channel-core kernel + lark-platform + deps; no `.ts`, no `node_modules`). Never hand-edited (design/runtime separation rule). Its `state.json` / logs / pid live in that same dir; its **config + secrets live in the shared `~/.knowledge-assistant/config/` bucket** (`config.yaml` + `secrets.yaml`), not here.
  > The pre-channel-core standalone `server.ts` and the `~/.lark-channel/config.json` layout are retired; on a machine still running an old daemon, `install.sh --switch` migrates its `state.json` and restarts the new one (populate `secrets.yaml channels.lark` first).

| File | Purpose |
|---|---|
| `lark-platform.ts` | the Lark platform adapter (per-group polling, CardKit streaming with webhook fallback, identity/self-filter, attachment download), driven by the `channels/core` kernel |
| `package.json` | dependencies: `@modelcontextprotocol/sdk` + `express` + `yaml` |
| `daemon.sh` | foreground runner: resolves `KA_HOME` → runs the `daemon.mjs` bundle under `flock`. **Don't run directly**, use `start.sh` |
| `start.sh` | idempotent launch: probe → orphan cleanup → background launch → wait ~5s |
| `stop.sh` / `status.sh` | `POST /api/shutdown` / `GET /api/status` |
| `tests/` | `pnpm test` — pure-function unit tests + e2e (fake lark-cli + mock webhook + real MCP client) |
| `skill/SKILL.md` | Claude Code ops skill (lifecycle / troubleshooting) |
| `ARCHITECTURE.md` | architecture design |

> The deployed runtime dir additionally holds `daemon.mjs` (the esbuild bundle), `state.json` (per-group watermarks), `channel.log` / `daemon.stdout.log` / `supervisor.log`, `daemon.pid`, and `.daemon.lock`. Real config + secrets are NOT in this dir — they live in `~/.knowledge-assistant/config/{config,secrets}.yaml`.

## One-time Deployment

```bash
# 1. Build only the Lark daemon bundle. Select Lark as the active kind when
#    switching it into service.
./install.sh --channel-kind=lark --only lark-daemon

# 2. Put the secrets in the shared secrets file (chmod 600). The daemon reads
#    them directly; the webhook tokens never leave the daemon process tree.
#    ~/.knowledge-assistant/config/secrets.yaml :
#      channels:
#        lark:
#          self_open_id: "ou_..."
#          groups:
#            oc_<chat_id>:
#              name: "Display Name"
#              webhook_url: "https://open.larksuite.com/open-apis/bot/v2/hook/<token>"
#              poll_interval_seconds: 5   # optional per-group override

# 3. The port (default 9876) + poll tuning are non-secret, in config.yaml:
#    ~/.knowledge-assistant/config/config.yaml channels.lark.{port, poll_interval_seconds, page_size, lark_cli_bin}
```

See [`SETUP.md`](./SETUP.md) for the full credential-gathering walkthrough.

> **Config split**: `self_open_id` and the per-group `webhook_url` come *only* from
> `secrets.yaml channels.lark` — never from `config.yaml` or the environment.
> The non-secret **port** / poll tuning / page size / `lark_cli_bin` live in
> `config.yaml channels.lark`. The daemon **fails closed**: an empty/missing
> `self_open_id` means it refuses to start (no env fallback, no silent default).

Codex replies use CardKit 2.0 streaming through the authenticated `lark-cli` bot
identity. The app must have message-send and card create/update scopes. If CardKit
creation, send, or a later content update is unavailable, the daemon automatically
sends the completed response through the configured group webhook instead. Interrupted,
failed, and text-less turns also close their placeholder card rather than leaving it
permanently in streaming mode.

The source label is emitted as its own paragraph (`**[#N-name]**\n\n`). CardKit
Markdown treats a single newline in ordinary prose as a soft break that clients
may collapse, so the adapter makes prose soft breaks explicit before card create
and update calls. Existing paragraph breaks and block Markdown—including fenced
code, headings, lists, quotes, and tables—remain unchanged. Webhook fallback keeps
the original plain text.

Codex mate names and working directories are owned exclusively by Workshop.
Workshop registers each live loopback App Server WebSocket endpoint and canonical
thread ID with Channel; the Lark daemon
does not read `workshop.yaml` and runtime targets are not duplicated under
`channels.lark`.

## Start / Stop / Inspect the daemon

```bash
~/.knowledge-assistant/channels/lark-daemon/start.sh     # idempotent launch (prints status and returns if already up)
~/.knowledge-assistant/channels/lark-daemon/status.sh    # health check: alive returns JSON + exit 0, dead exit 1
~/.knowledge-assistant/channels/lark-daemon/stop.sh      # graceful stop (POST /api/shutdown)
curl -s 127.0.0.1:9876/api/status | python3 -m json.tool # detailed status
```

**Self-heal (two layers)**:

- **① Process level** (daemon crash) — recommended to wire a cron pull every minute (back up within ≤60s if it dies):

```cron
* * * * * ~/.knowledge-assistant/channels/lark-daemon/start.sh >> ~/.knowledge-assistant/channels/lark-daemon/supervisor.log 2>&1
```

- **② Connection level / half-open self-heal** — write-style keepalive probing (v0.6.2) detects a stale one-way consumer and evicts it after 3 strikes; after a daemon restart the client re-handshakes via 404 / re-adopt and seamlessly resumes, **no manual intervention** (see [`ARCHITECTURE.md`](./ARCHITECTURE.md)).
  - ⚠️ A daemon **process restart** (code upgrade) loses in-memory sessions; existing CCs reconnecting with old ids hit 404 and go idle — in this case **no need to restart the CC** (which would lose runtime context); manually have it call an MCP tool once in its window to trigger a re-init and resume.

**Singleton**: a second daemon hitting port 9876 → `EADDRINUSE` → clean exit (exit 0).
(`daemon.sh` also uses `flock` when present; macOS has no flock, falling back to port-binding for the singleton.)

## Launch a CC bound to a channel: `claude-ch`

```bash
claude-ch main  --dangerously-skip-permissions --dangerously-load-development-channels server:lark-channel
claude-ch audit --dangerously-skip-permissions --dangerously-load-development-channels server:lark-channel
claude-ch weexrepo --dangerously-skip-permissions ...
```

What `claude-ch` (at `~/.local/bin/claude-ch`) does: sanitizes the channel name to `a-z0-9_-`, generates a temporary MCP config that overrides the URL to `…/mcp?name=<name>`, then `exec claude --mcp-config <temp config> [remaining args]`.

- The first argument is the channel name; the rest pass through verbatim to `claude`.
- The first time, a dev-channels security confirmation pops up; choose the local-development option to allow.
- After launch, `curl 127.0.0.1:9876/api/status`'s `channels_online` will show that channel.

## Lark-side routing syntax

| Form | Behavior |
|---|---|
| `content` | **Sticky** → reuses this chat's last single target (see below) |
| `to <name>: content` / `to <name> content` / `2<name>` / `2 <name> content` | Targeted to `<name>` (prefix `to`/`2`, spaces flexible, colon optional) |
| `to 1:` / `to2:` / `to 3` / `2 1: content` | Targeted by **number** (numbers in `/api/status`'s `channel_numbers`) |
| `to all: content` / `2 all content` | Broadcast to all online channels |
| `to <nonexistent>: content` | With explicit colon → daemon replies "offline" + lists online channels (#numbers) |

> Since v0.5.3 the prefix is lenient (`to`/`2`, colon optional); **without a colon, routing only happens if the target matches an online channel (name or number)**, otherwise it's treated as a plain message (so `tomorrow…`/`2 weeks…` won't be misrouted). Channel names can't contain characters like `.` (`weex.repo`→`weexrepo`).
>
> **Sticky routing**: a plain message with no `to` prefix goes to the **last single target this chat routed to** (stored **per chat** as `last_target_by_chat`, since a lark daemon serves many group chats). Only an explicit **single, non-`all`** target sticks; multi-target and `to all` do not. A chat's first plain message (nothing remembered yet) or one whose remembered target is offline is **not** silently defaulted — the daemon replies asking to pick a channel + lists who's online. Same core decision (`applyStickyRouting`, `channels/core/src/routing.ts`) as telegram; only the persistence shape differs (telegram: one global `last_target`; lark: keyed per chat). The old per-chat attachment-target store now rides on this same sticky store.

## HTTP API

Listens on `127.0.0.1:9876` (loopback only). DNS rebinding protection auto-applied for localhost.

| Method | Path | Purpose |
|---|---|---|
| `POST / GET / DELETE` | `/mcp` | MCP Streamable HTTP transport. Claude Code's MCP client lives here. Session-aware (per-Claude-process). |
| `GET` | `/api/status` | Health, MCP sessions, `runtime_targets`, channel names/numbers, dispatch/reply/probe counters, Lark poll health, and per-chat watermarks. |
| `POST` | `/api/runtimes/codex` | Workshop-only loopback registration of a Codex App Server endpoint + canonical thread. |
| `DELETE` | `/api/runtimes/codex/:name` | Unregister a Workshop-managed Codex target. |
| `POST` | `/api/runtimes/codex/:name/deliver` | Submit an automation prompt to an already registered Codex target. |
| `GET` | `/api/metrics` | Prometheus exposition format (text/plain) |
| `POST` | `/api/shutdown` | Graceful exit (loopback only) |

The `active_owners` field = `{channel name: first 8 chars of session-id}`, showing which session each channel currently belongs to.

## Common ops

```bash
# Status
~/.knowledge-assistant/channels/lark-daemon/status.sh | jq

# Start (idempotent)
~/.knowledge-assistant/channels/lark-daemon/start.sh

# Graceful stop
~/.knowledge-assistant/channels/lark-daemon/stop.sh

# Force restart
~/.knowledge-assistant/channels/lark-daemon/stop.sh && sleep 1 && ~/.knowledge-assistant/channels/lark-daemon/start.sh

# Live log tail
tail -f ~/.knowledge-assistant/channels/lark-daemon/channel.log

# Recent dispatches / errors
grep "dispatch" ~/.knowledge-assistant/channels/lark-daemon/channel.log | tail -10
grep -E "error|fail|exception|uncaught" ~/.knowledge-assistant/channels/lark-daemon/channel.log | tail -10

# Manually rewind watermark (replay missed messages): edit
# ~/.knowledge-assistant/channels/lark-daemon/state.json, set last_seen_msg_time[chat_id]
# to an earlier ISO timestamp. Daemon picks up on the next poll (no restart needed).
```

## Adding a new Lark group

1. Edit `~/.knowledge-assistant/config/secrets.yaml` → `channels.lark.groups`:
   ```yaml
   channels:
     lark:
       groups:
         oc_NEW_CHAT_ID:
           name: "Display Name"
           webhook_url: "https://open.larksuite.com/open-apis/bot/v2/hook/..."
   ```
2. Restart: `~/.knowledge-assistant/channels/lark-daemon/stop.sh && ~/.knowledge-assistant/channels/lark-daemon/start.sh`
3. Daemon anchors the watermark at NOW for the new group (no replay of old history).

## Security Iron Rules

- **The daemon holds the webhook tokens; agent-runtime processes never touch them.** Claude Code communicates through MCP and Codex through App Server; credentials remain at the single channel exit.
- **self filter**: only messages whose `sender.id === self_open_id` (and `sender_type === user`) are processed; bot messages, other users' messages, and card messages are discarded (prevents prompt injection from other chat members).
- `secrets.yaml` is `chmod 600` and gitignored; CC processes never see the webhook tokens.

## Debug checklist (when something stops working)

1. **`status.sh` exit 1**: daemon dead. Check `tail -50 ~/.knowledge-assistant/channels/lark-daemon/channel.log` for crash trace. Re-launch via `start.sh`.
2. **Target absent**: for Claude Code, `mcp_sessions: 0` means no MCP client is connected; re-run `claude-ch <name>` or restart Claude Code. For Codex, inspect `runtime_targets` and repair/restart the corresponding Workshop mate if it is absent or `alive: false`.
3. **`poll_errors_total` climbs**: lark-cli calls failing (auth expired? `lark_cli_bin` path? chat_id correct?). `grep "fetch failed" channel.log | tail` for cause; run the lark-cli command manually to see the error.
4. **Watermark doesn't advance**: no Claude MCP session or Codex runtime target is online (intentional replay behavior). To genuinely skip ahead while no target is connected, manually edit `state.json`.
5. **HTTP port 9876 occupied**: `lsof -nP -iTCP:9876 -sTCP:LISTEN` (or `ss -tlnp | grep 9876`) and kill the orphan.
6. **Two daemons running somehow**: shouldn't happen due to flock, but if it does: `ps -ef | grep daemon.mjs`, kill the one without the flock-wrapped parent.

## Limitations / known issues

- **MCP tool hot-load**: Claude Code only connects to MCP servers at session start. If the daemon was down when Claude started, no MCP connection until Claude restart.
- **Lark API rate limits**: heavy polling may hit `99991400 request trigger frequency limit`. Per-group intervals (base 1s, per-group override e.g. 5s). If `99991400` appears, raise the busy group's `poll_interval_seconds` in `secrets.yaml channels.lark.groups.<id>.poll_interval_seconds` (or the global `config.yaml channels.lark.poll_interval_seconds`).
- **Single user assumption**: `self_open_id` filter — only the user's own typed messages trigger dispatch. Bot messages and other users' messages are ignored (prevents prompt injection from other chat members).
- **Webhook delivery is fire-and-forget**: if a Lark webhook returns non-zero, the daemon logs but doesn't retry. Out-of-order edge cases at message-edit time are not handled.

## Version history

- **v0.6.2 (2026-05-25)** — Probing re-added: write-style `notifications/claude/keepalive`, runs every 5s, evict only after 3 strikes, top-2 per name never evicted (protects the consumer). Added `probe_evicted_total / probes_sent_total / probe_failures_total / channel_alive`. Known limitation: can't probe when the process is dead but OS-level TCP hasn't FIN'd → backstopped by FIFO.
- **v0.6.0 (2026-05-25)** — Session storage refactor: single Map `byName: Map<name, Session[]>` + per-name FIFO of 4; `monoTs` (hrtime nanoseconds) ordering to avoid collisions; `sessionsById` only as an HTTP routing aid. Fully resolves session accumulation bloat.
- **v0.5.3 (2026-05-21)** — 🔴 Fixed the "dispatched but doesn't surface" bug: meta must be all-string (removed numeric channel_number); deleted ping probing (falsely killed the consumer); delivery changed back to all same-named sessions + parallel timeout; lenient prefix + channel numbers; per-group poll (base 1s, per-group override). See [`ARCHITECTURE.md`](./ARCHITECTURE.md) §11
- **v0.4.0 (2026-05-20)** — named channel + owner model, `to <name>:` targeting + `to all:` broadcast, message_id dedup, 404 self-heal, reply auto `[name]` prefix, `claude-ch` wrapper script
- v0.2 (2026-05-11) — Standalone HTTP daemon, decoupled from Claude Code, cron-supervised
- v0.1 (2026-05-07) — Original stdio MCP subprocess (deprecated, see ARCHITECTURE.md §2)
</content>
</invoke>
