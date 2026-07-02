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

status_resp=$(curl -sf --max-time 2 "http://$HOST:$PORT/api/status" 2>/dev/null || true)
if [ -n "$status_resp" ]; then
  echo "✓ already running"
  echo "$status_resp"
  exit 0
fi

# CRITICAL (race guard): /api/status can time out for MINUTES on cold start because
# loading the 2.2GB e5 model blocks the event loop. A process LISTENING on the port is
# the daemon (warming or ready) — treat it as up. The port bind IS the macOS singleton
# (no flock), and the daemon's own EADDRINUSE exit prevents duplicates. No orphan-killing
# cleanup here: it was redundant with the port singleton and caused a race where two
# concurrent `start` invocations (e.g. the 1-min keepalive overlapping a manual start)
# killed each other's freshly-started daemon — the exact boot-time restart storm we hit.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✓ already running (port $PORT bound — daemon up, may still be warming)"
  exit 0
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
