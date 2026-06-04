#!/bin/bash
# ka daemon — operate on the ACTIVE channel daemon. Which daemon (telegram|lark)
# and its port come from the single source of truth: config.yaml channel_kind +
# runtime/<kind>-daemon/config.json http_port (resolved in common.sh). There is
# no per-command kind override — to switch kinds, edit config.yaml (or re-run
# ./install.sh --channel-kind=…) and restart.
set -euo pipefail
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$THIS_DIR/common.sh"

KIND="$(ka_channel_kind)" || exit 2
DIR="$(ka_daemon_dir)"
PORT="$(ka_channel_port)"
HOST="127.0.0.1"

_up() { curl -sf --max-time 2 "http://$HOST:$PORT/api/status" >/dev/null 2>&1; }

VERB="${1:-status}"; [ $# -gt 0 ] && shift || true
case "$VERB" in
    start)
        [ -x "$DIR/start.sh" ] || { log_err "$KIND daemon not deployed at $DIR (run ./install.sh --only daemon)"; exit 1; }
        log_info "starting $KIND daemon (port $PORT)…"
        exec "$DIR/start.sh"
        ;;
    stop)
        [ -x "$DIR/stop.sh" ] || { log_err "$KIND daemon not deployed at $DIR"; exit 1; }
        log_info "stopping $KIND daemon (port $PORT)…"
        exec "$DIR/stop.sh"
        ;;
    restart)
        [ -x "$DIR/start.sh" ] || { log_err "$KIND daemon not deployed at $DIR (run ./install.sh --only daemon)"; exit 1; }
        log_info "restarting $KIND daemon (port $PORT) — channels blip ~2s, then re-adopt automatically…"
        [ -x "$DIR/stop.sh" ] && "$DIR/stop.sh" >/dev/null 2>&1 || true
        sleep 1
        if "$DIR/start.sh" >/dev/null 2>&1; then
            sleep 2   # let the CCs re-adopt before the summary
            exec bash "$0" status   # show the pretty status summary
        else
            log_err "$KIND daemon failed to start — see $DIR/daemon.stdout.log"
            exit 1
        fi
        ;;
    status)
        resp="$(curl -sf --max-time 2 "http://$HOST:$PORT/api/status" 2>/dev/null || true)"
        if [ -z "$resp" ]; then
            log_warn "$KIND daemon down (port $PORT) — start with: ka daemon start"
            exit 1
        fi
        log_ok "$KIND daemon up (port $PORT, dir $(basename "$DIR"))"
        if [ "${1:-}" = "--json" ]; then
            # raw (pretty-printed) JSON for scripting / full detail
            printf '%s\n' "$resp" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$resp"
            exit 0
        fi
        # human-readable summary (falls back to raw JSON if python/parse fails).
        # JSON is passed via env (the heredoc owns stdin, so it can't be piped in).
        RESP="$resp" python3 - <<'PY' 2>/dev/null || printf '%s\n' "$resp"
import os, json
d = json.loads(os.environ["RESP"])
up = int(d.get("uptime_seconds", 0)); h, m = up // 3600, (up % 3600) // 60
on = d.get("channels_online", {}) or {}
nums = d.get("channel_numbers", {}) or {}
alive = d.get("channel_alive", {}) or {}
print(f"  pid {d.get('pid', '?')} · uptime {h}h{m}m · {len(on)} channel(s) online")
names = sorted(on.keys(), key=lambda n: nums.get(n, 999))
if names:
    print(f"  {'CHANNEL':<16}{'#':<5}{'ONLINE':<8}ALIVE")
    for n in names:
        print(f"  {n:<16}{str(nums.get(n, '?')):<5}{('yes' if on.get(n) else 'no'):<8}{'yes' if alive.get(n) else 'no'}")
print(f"  dispatches {d.get('dispatches_total', 0)} · replies {d.get('replies_total', 0)} "
      f"({d.get('replies_failed_total', 0)} failed) · probes {d.get('probes_sent_total', 0)} "
      f"({d.get('probe_failures_total', 0)} failed)")
PY
        ;;
    config)
        cfgjson="$DIR/config.json"
        [ -f "$cfgjson" ] || { log_err "no config.json at $cfgjson (run ./install.sh --only daemon first)"; exit 1; }
        log_info "editing $KIND daemon config: $cfgjson (apply with: ka daemon restart)"
        exec "${EDITOR:-vi}" "$cfgjson"
        ;;
    -h|--help|help|'')
        cat <<EOF
ka daemon — operate on the active channel daemon ($KIND, from config.yaml channel_kind)
  ka daemon start      start the daemon
  ka daemon stop       stop the daemon
  ka daemon restart    restart it (CCs re-adopt automatically, ~2s blip)
  ka daemon status     health check (shows kind + port)
  ka daemon config     edit the daemon's config.json (\$EDITOR), then: ka daemon restart
EOF
        ;;
    *)
        log_err "unknown: ka daemon '$VERB' (try: ka daemon help)"; exit 2 ;;
esac
