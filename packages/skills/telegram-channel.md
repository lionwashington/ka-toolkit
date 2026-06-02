---
name: telegram-channel
description: Inspect the telegram-channel daemon — show all channels (number/name), online/alive state, active owner sessions, dispatch/probe counters, diagnose "half-open" connections (messages silently not delivered), and restart the daemon. Use when the user asks about channel status, who's online, why a CC didn't receive a Telegram message, or daemon health.
user-invocable: true
---

# Telegram-Channel Daemon Inspector

The telegram-channel **daemon** is the single process that long-polls Telegram and
routes each incoming message to the right CC session over MCP (StreamableHTTP).
It also serves the `reply` / `send_to_channel` MCP tools. One daemon, one port,
many channels — each CC pane binds to a channel by name.

- Default port: `9877` (override `KA_CHANNEL_PORT`; isolated test instances use 9878/9879).
- Runtime location (post ka-gen2 switch): `~/.knowledge-assistant/runtime/daemon/`
  with `start.sh` / `stop.sh` / `status.sh`.
- Full health is exposed at `GET http://127.0.0.1:<port>/api/status` (JSON).

Parse the user's input after `/telegram-channel` (aliases: `/tc`, "channel status",
"who's online", "daemon status") to pick an action.

## `/tc` or `/tc status` — full daemon state

Run this and show the formatted output:

```bash
PORT="${KA_CHANNEL_PORT:-9877}"
curl -sf --max-time 3 "http://127.0.0.1:$PORT/api/status" | python3 -c '
import json, sys
d = json.load(sys.stdin)
nums   = d.get("channel_numbers", {})
online = d.get("channels_online", {})
alive  = d.get("channel_alive", {})
owners = d.get("active_owners", {})
ages   = {s["name"]: s["age_seconds"] for s in d.get("sessions", [])}

ok  = "UP" if d.get("ok") else "DOWN"
pid = d.get("pid"); up = d.get("uptime_seconds", 0); ms = d.get("mcp_sessions", 0)
print(f"daemon: {ok}  pid={pid}  uptime={up}s  mcp_sessions={ms}")
print()
print("  {:>3}  {:<16}  {:<6}  {:<6}  {:<10}  age".format("#", "channel", "online", "alive", "owner"))
print("  " + "  ".join(["-"*3, "-"*16, "-"*6, "-"*6, "-"*10, "-"*5]))
for name in sorted(nums, key=lambda n: nums[n]):
    on = "yes" if online.get(name) else "-"
    if alive.get(name):    al = "yes"
    elif name in alive:    al = "NO"
    else:                  al = "-"
    ow   = (owners.get(name) or "-")[:8]
    ag   = (str(ages[name]) + "s") if name in ages else "-"
    flag = "" if (alive.get(name) or name not in alive) else "   << HALF-OPEN"
    print("  {:>3}  {:<16}  {:<6}  {:<6}  {:<10}  {}{}".format(nums[name], name, on, al, ow, ag, flag))
print()
disp = d.get("dispatches_total", 0); rep = d.get("replies_total", 0)
repf = d.get("replies_failed_total", 0); rm = d.get("route_miss_total", 0)
print(f"  dispatches={disp}  replies={rep}  replies_failed={repf}  route_miss={rm}")
ps = d.get("probes_sent_total", 0); pf = d.get("probe_failures_total", 0)
pe = d.get("probe_evicted_total", 0); poe = d.get("poll_errors_total", 0)
print(f"  probes_sent={ps}  probe_failures={pf}  probe_evicted={pe}  poll_errors={poe}")
lp = d.get("last_poll_at", "?")
print(f"  last_poll={lp}")
' 2>/dev/null || echo "daemon DOWN on port $PORT (curl failed) — start it: ~/.knowledge-assistant/runtime/daemon/start.sh"
```

Reading the table:
- **online=yes, alive=yes, owner set** → healthy; messages route fine.
- **alive=NO (<< HALF-OPEN)** → the daemon still holds an MCP session for this channel,
  but its server→client push channel is dead. The daemon will `dispatch` messages and
  count them as sent, **but the CC silently never receives them.** This is the classic
  failure after a network blip / laptop sleep. **Fix: restart the daemon** (see below).
- **channel in `#`/numbers list but online=- / owner=-** → no live CC bound; that pane
  is down or never connected. Start the pane (`ka workshop start <name>`).
- **probe_failures / poll_errors climbing** → recent network instability; expect
  half-open sessions to follow.

## `/tc diag` — one-line verdict

```bash
PORT="${KA_CHANNEL_PORT:-9877}"
curl -sf --max-time 3 "http://127.0.0.1:$PORT/api/status" | python3 -c '
import json, sys
d = json.load(sys.stdin)
alive = d.get("channel_alive", {})
dead  = [n for n in alive if alive[n] is False]
pf    = d.get("probe_failures_total", 0)
if dead:
    print("DEGRADED - half-open channel(s): " + ", ".join(dead) + "  -> restart daemon (stop.sh && start.sh)")
else:
    print("OK - " + str(len(alive)) + " channel(s) all alive, " + str(pf) + " probe failures total")
' 2>/dev/null || echo "DOWN - daemon not answering on $PORT"
```

## `/tc restart` — restart the daemon

A restart **drops every CC's channel for a few seconds**, then each live CC rebuilds
its MCP connection cleanly — this is exactly what cures half-open sessions.

> ⚠ Run from a **plain terminal, not from inside a workshop pane** — restarting kills
> the channel of the CC you're typing in too. If you are a CC inside the workshop,
> tell the user to run it themselves.

```bash
D="$HOME/.knowledge-assistant/runtime/daemon"
"$D/stop.sh"; sleep 1; "$D/start.sh"
"$D/status.sh"   # re-check
```

The daemon reloads `state.json` on start, so **channel numbers are preserved** across
restarts (they're persisted, not reassigned).

## Notes

- This skill only *reads* `/api/status` and (on explicit request) restarts the daemon.
  It never edits daemon config/secrets — those live in `runtime/daemon/{config.json,.env}`.
- `ka status` / `ka doctor` give a coarser one-line daemon check; use this skill when
  you need the per-channel breakdown or a half-open diagnosis.
