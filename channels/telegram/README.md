# telegram-channel

Standalone background daemon that bridges **the owner's Telegram DM** with **multiple Claude Code processes** in both directions:
the owner routes messages to different CCs with `to <channel name>: content`, and a CC replies to the owner's DM via the `reply` tool.
The credential (bot token) lives only at this single daemon exit; **CC processes never touch the token**.

> Implementation-level design / invariants / historical decisions are in [`docs/telegram-channel-design.md`](../../docs/telegram-channel-design.md) (as-built).

```
Owner's Telegram DM
  │ ① getUpdates long-poll (daemon owns the token exclusively, offset cursor)
  ▼
telegram-channel daemon  (node+express @127.0.0.1:9877)
  │ ② notifications/claude/channel over /mcp SSE
  ▼
CC processes (started with tg-ch <name>, each bound to a channel)
  │ ③ CC calls reply{chat_id,text}
  ▼
daemon ── ④ bot.api.sendMessage(owner, "**[<name>]** "+text) ──▶ Owner's Telegram
```

## Directory

- **Source (source-of-truth, committed to git)**: `channels/telegram/`
- **Runtime directory (not in git)**: `~/.knowledge-assistant/runtime/daemon/` — copied from source by `install.sh --only daemon` (never hand-edited, per the design/runtime separation rule), plus `.env`/`config.json`/`state.json` and other runtime/secret files.
  > The old location `~/.telegram-channel/` is deprecated (migrated to runtime/daemon in D2/P1.4); if an old daemon is still running, `install.sh --switch` migrates the secrets over.

| File | Purpose |
|---|---|
| `server.ts` | daemon itself (Node + TS via `--experimental-strip-types`) |
| `package.json` | dependencies: `@modelcontextprotocol/sdk` + `express` + `grammy` |
| `config.example.json` | config template (port / poll / owner_chat_id) |
| `daemon.sh` | foreground runner: source `.env` → single-instance node launch. **Don't run directly**, use `start.sh` |
| `start.sh` | idempotent launch: probe → orphan cleanup → background launch → wait 5s |
| `stop.sh` / `status.sh` | `POST /api/shutdown` / `GET /api/status` |
| `tg-ch` | wrapper to launch a CC bound to a channel (see below) |

## One-time Deployment

```bash
# 1. Deploy source to the runtime directory (idempotent; runtime can only be produced by install, never hand-edited)
./install.sh --only daemon

# 2. Configure .env (runtime directory, chmod 600) — the daemon process sources it itself, token doesn't leak
cat > ~/.knowledge-assistant/runtime/daemon/.env <<'EOF'
TELEGRAM_BOT_TOKEN=<your bot token>
EOF
chmod 600 ~/.knowledge-assistant/runtime/daemon/.env

# 3. Configure owner (config.json's owner_chat_id = your Telegram numeric user id)
#    install already seeds from config.example.json; to change owner/port, edit directly:
#    ~/.knowledge-assistant/runtime/daemon/config.json
```

> **Owner source**: owner is taken from **`.env` `OWNER_CHAT_ID` first, config.json `owner_chat_id` as fallback** (use env if env is non-empty); token is taken from **.env `TELEGRAM_BOT_TOKEN`**.
> Recommended to put both token + owner in `.env` (single secret source):
> ```
> TELEGRAM_BOT_TOKEN=<token>
> OWNER_CHAT_ID=<your numeric user id>
> ```
> config.json's `owner_chat_id` serves as the fallback when env isn't set.

## Start / Stop / Inspect the daemon

```bash
~/.knowledge-assistant/runtime/daemon/start.sh     # idempotent launch (prints status and returns if already up)
~/.knowledge-assistant/runtime/daemon/status.sh    # health check: alive returns JSON + exit 0, dead exit 1
~/.knowledge-assistant/runtime/daemon/stop.sh      # graceful stop (POST /api/shutdown)
curl -s 127.0.0.1:9877/api/status | python3 -m json.tool   # detailed status
```

**Self-heal (two layers)**:

- **① Process level** (daemon crash) — recommended to wire a cron pull every minute (back up within ≤60s if it dies):

```cron
* * * * * ~/.knowledge-assistant/runtime/daemon/start.sh >> ~/.knowledge-assistant/runtime/daemon/supervisor.log 2>&1
```

- **② Connection level / half-open self-heal (M6, 2026-05-31)** — when network jitter causes the CC↔daemon SSE to go one-way half-open (process hasn't crashed, TCP hasn't dropped, but CC isn't receiving dispatches), the daemon's ping probe detects it and automatically `closeStandaloneSSEStream()` (closes the notification stream, keeps the session), triggering CC to reconnect with the same session-id and seamlessly resume, **no manual intervention, no restart** (see `docs/telegram-channel-design.md` A4/A5).
  - ⚠️ A daemon **process restart** (code upgrade) loses in-memory sessions; existing CCs reconnecting with old ids hit 404 and go idle — in this case **no need to restart the CC** (which would lose runtime context); manually have it call an MCP tool once in its window to trigger a re-init and resume.

**Singleton**: a second daemon hitting port 9877 → `EADDRINUSE` → clean exit (exit 0).
(`daemon.sh` also uses `flock` when present; macOS has no flock, falling back to port-binding for the singleton.)

## Launch a CC bound to a channel: `tg-ch`

```bash
channels/telegram/tg-ch ka                 # launch an interactive CC bound to channel "ka"
channels/telegram/tg-ch audit --model opus # extra args pass through to claude
TG_CHANNEL_PORT=9999 channels/telegram/tg-ch main   # change daemon port (default 9877)
```

- The first time, a dev-channels security confirmation pops up; choose `1. I am using this for local development` to allow.
- The channel name is sanitized (lowercase, only `a-z0-9_-`, empty → `main`), consistent with the daemon internals.
- After launch, `curl 127.0.0.1:9877/api/status`'s `channels_online` will show that channel.
- To clean up the registration when done: `claude mcp remove telegram-channel`.

> `tg-ch` uses a "single `telegram-channel` MCP server registration + URL redirect to `?name=<name>` each time" mechanism (**the registration is written to the project-local scope of the cwd where tg-ch is called**, not touching global mcpServers / settings.json).
>
> **Concurrency test conclusions (2026-05-29)**:
> - ✅ **No cross-talk**: a CC caches the MCP config from startup; on a disconnect 404 reconnect it **returns to its own original channel**, not reading the "latest registered value". Verified: in the same cwd, `tg-ch test1`→`tg-ch test2` in sequence (the shared registration changed to `?name=test2`), restarting the daemon forced the test1 CC to reconnect, and **test1 still came back to test1** (not test2). So concurrent multi-channels are each independent and don't cross-talk.
> - ⚠️ **A daemon restart silently drops all dev-channels consumers**: after the restart they don't auto-reconnect; you need to send the CC an operation (e.g. have it call a tool) to trigger a 404 reconnect, or just restart that CC (same lesson as lark). **Don't restart the daemon in daily use.**
> - ⚠️ **Startup race**: the registration is the shared value at "the moment tg-ch is called", so **start them sequentially** (wait for one channel to connect before starting the next); don't concurrently start multiple tg-ch at once (they'd contend for the same registration).
> - True concurrent multi-channel steady-state management (one pane per channel) is carried by the later spawn/start-pane path.
>
> **Note**: `tg-ch` does **not** include `--dangerously-skip-permissions` by default, so a CC calling `reply` will prompt for permission. To let a channel CC auto-reply, add it yourself at startup: `tg-ch <name> --dangerously-skip-permissions`.

## Routing Syntax (owner side, in Telegram)

| Form | Behavior |
|---|---|
| `content` (no prefix) | Default → `main` channel |
| `to <name>: content` / `to <name> content` | Targeted to `<name>` (prefix `to`/`2`, colon optional, spaces flexible) |
| `to <number>: content` | Targeted by number (numbers in `/api/status`'s `channel_numbers`) |
| `to all: content` | Broadcast to all online channels |
| `to <nonexistent>: content` | daemon replies "channel offline" + lists currently online channels |

- A no-prefix message defaults to `main`; if no `main` channel is online → daemon returns a route-miss hint (not a bug).
- **Offset doesn't advance when there's no session**: messages the owner sent while offline are replayed after the corresponding CC reconnects.

## Security Iron Rules

- **The daemon holds the token; CC processes (including every mate) never touch the token.** CC only sends/receives via MCP; the credential lives at a single exit.
- **self filter**: only messages with `from.id === owner_chat_id` are processed, everything else is discarded (prevents prompt injection / stranger harassment).
- **reply is forced to the owner**: the `reply` tool ignores the `chat_id` passed in by CC; the daemon always sends to `config.owner_chat_id` — an injected CC can't use reply to send to an arbitrary chat.
- `.env` is `chmod 600` and excluded by `.gitignore`, never committed to git.

## Troubleshooting

| Symptom | Cause / Handling |
|---|---|
| **`409 Conflict`** (getUpdates errors, `poll_errors_total` spikes) | A single bot token allows only **one** getUpdates consumer. Most likely another process (old daemon / main telegram plugin / another polling source) is using the same token. `stop.sh` to kill the duplicate process, or give the daemon a **separate bot token** (use a separate test bot during rollout to avoid the main bot). |
| **Port occupied** | `lsof -nP -iTCP:9877 -sTCP:LISTEN` to find the process; most likely the previous daemon is still alive (port-binding singleton makes the new process exit 0, which is normal). To restart, `stop.sh` first. |
| **Message didn't reach CC** | ① `status.sh` to check whether the target channel is in `channels_online` and `channel_alive` is true; ② check `channel.log` for `dispatch → "<name>"`; ③ confirm the CC's pane shows `Listening for channel messages from: server:telegram-channel` at startup (if not, the registration didn't take effect, re-run `tg-ch`). |
| **route-miss** (owner receives "channel X offline") | The target channel isn't online, or a no-prefix message was sent with no `main` channel. **This is expected feedback**, not a bug. The `route_miss_total` counter in `status.sh`. |
| **self filter swallowed the message** | Only the owner (`config.owner_chat_id`) can reach. Messages from others are dropped + logged `drop non-owner`. Confirm `owner_chat_id` matches your own numeric id. |
| **token empty** | The daemon exits immediately on startup with `FATAL: env TELEGRAM_BOT_TOKEN is empty`. Check `~/.knowledge-assistant/runtime/daemon/.env`. |
| **A CC stops receiving pushes after a daemon restart** | A daemon restart breaks the SSE notification stream, and the old CC's consumer may still be bound to a dead session. **Restart the corresponding CC** to rebind (not restarting the daemon in daily use avoids this). |

## Logs

- `~/.knowledge-assistant/runtime/daemon/channel.log` — the daemon's own lifecycle / dispatch / error log.
- `~/.knowledge-assistant/runtime/daemon/daemon.stdout.log` — stdout/stderr from the background launch.
