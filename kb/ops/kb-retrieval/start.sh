#!/bin/bash
# kb-retrieval idempotent start. Safe from a skill, cron, or manually.
#   - If already running (/api/status responds): print status, exit 0
#   - Else: double-fork daemon.sh into background and detach
# Singleton is enforced by daemon.sh (flock) / the daemon (port bind).
set -u
# Minimal launchd/cron PATH lacks Homebrew/nvm — keep this in sync with daemon.sh so
# the forked daemon (and any node here) resolves under a keepalive env, not just a shell.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

HOST="127.0.0.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # $KA_HOME/kb/mcp/kb
: "${KA_HOME:=$(cd "$ROOT/../../.." && pwd)}"
CONFIG_YAML="${KA_CONFIG:-${KA_CONFIG_DIR:-$KA_HOME/config}/config.yaml}"
# Port = config.yaml retrieval.daemon.port (single source of truth; the daemon
# binds the same value). Fall back to 7705 only if the entry is absent.
PORT="$(awk '
  { match($0,/^ */); i=RLENGTH }
  i==0 { k=$0; sub(/:.*/,"",k); gsub(/[ \t]/,"",k); r=(k=="retrieval")?1:0; d=0; next }
  r&&i==2 { k=$0; gsub(/^ +/,"",k); sub(/:.*/,"",k); gsub(/[ \t]/,"",k); d=(k=="daemon")?1:0; next }
  r&&d&&i>=4&&/port[ \t]*:/ { v=$0; sub(/.*port[ \t]*:[ \t]*/,"",v); gsub(/[^0-9]/,"",v); if(v!=""){print v; exit} }
' "$CONFIG_YAML" 2>/dev/null)"
[ -n "$PORT" ] || PORT="7705"
LOG="$ROOT/daemon.stdout.log"
STATE_DIR="${KA_STATE_DIR:-$KA_HOME/state}"
HEALTH_FILE="$STATE_DIR/kb-retrieval-health"
mkdir -p "$STATE_DIR"
# shellcheck source=daemon-process.sh
source "$ROOT/daemon-process.sh"

status_resp=$(curl -sf --max-time 2 "http://$HOST:$PORT/api/status" 2>/dev/null || true)
if [ -n "$status_resp" ]; then
  rm -f "$HEALTH_FILE"
  echo "✓ already running"
  echo "$status_resp"
  exit 0
fi

# A bound port with an unresponsive event loop is ambiguous: cold model warmup is
# legitimately silent, but a swap-thrashing ONNX process can stay half-dead forever.
# Give every new PID a generous warmup grace, then require several consecutive
# keepalive failures before an exact, validated-PID restart. This retains the old
# race guard while making the one-minute keepalive actually self-heal a wedged daemon.
daemon_pid="$(kb_daemon_pid "$PORT" 2>/dev/null || true)"
if [ -n "$daemon_pid" ]; then
  age="$(kb_pid_age_seconds)"
  # A startup incremental reindex of several large topics can legitimately run
  # for close to an hour on the supported 2-core/4-GB host with the low-memory
  # embed batch. Do not let the one-minute keepalive kill that useful work.
  # Existing long-lived PIDs do not receive this grace, so a later wedge still
  # begins its three-strike recovery immediately.
  warm_grace="${KA_KB_WARM_GRACE_SECONDS:-3600}"
  failure_limit="${KA_KB_HEALTH_FAILURE_LIMIT:-3}"
  if [ "$age" -lt "$warm_grace" ]; then
    rm -f "$HEALTH_FILE"
    echo "✓ already running (pid $daemon_pid, port $PORT bound — warming for ${age}s)"
    exit 0
  fi

  old_pid=""; failures=0
  if [ -f "$HEALTH_FILE" ]; then
    read -r old_pid failures _ < "$HEALTH_FILE" || true
  fi
  [ "$old_pid" = "$daemon_pid" ] || failures=0
  failures=$((failures + 1))
  health_tmp="$HEALTH_FILE.$$"
  printf '%s %s %s\n' "$daemon_pid" "$failures" "$(date +%s)" > "$health_tmp"
  mv "$health_tmp" "$HEALTH_FILE"
  if [ "$failures" -lt "$failure_limit" ]; then
    echo "⚠ daemon pid $daemon_pid is listening but /api/status is unresponsive (health strike $failures/$failure_limit)"
    exit 0
  fi

  echo "⚠ daemon pid $daemon_pid failed health $failures consecutive times; restarting"
  if ! kb_stop_daemon_pid "$daemon_pid"; then
    echo "✗ failed to stop unresponsive validated daemon pid $daemon_pid" >&2
    exit 1
  fi
  rm -f "$HEALTH_FILE"
elif lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✗ port $PORT is bound by a process that is not the deployed KB daemon; refusing to kill it" >&2
  exit 1
fi

# Launch detached. The model loads on warmup (~10-50s first time) before /api/status
# reports ready:true — so wait longer than a channel daemon.
if command -v setsid >/dev/null 2>&1; then
  nohup setsid bash "$ROOT/daemon.sh" </dev/null >>"$LOG" 2>&1 &
else
  nohup bash "$ROOT/daemon.sh" </dev/null >>"$LOG" 2>&1 &
fi
disown 2>/dev/null || true

# Wait up to ~60s for the port to come up (model load on cold start is slow).
for i in $(seq 1 120); do
  sleep 0.5
  status_resp=$(curl -sf --max-time 1 "http://$HOST:$PORT/api/status" 2>/dev/null || true)
  if [ -n "$status_resp" ]; then
    echo "✓ started (after $((i / 2))s; model may still be warming — check ready:true)"
    echo "$status_resp"
    exit 0
  fi
done

echo "✗ failed to start within 60s; see $LOG"
tail -20 "$LOG" 2>/dev/null || true
exit 1
