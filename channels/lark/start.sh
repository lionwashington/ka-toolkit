#!/bin/bash
# lark-channel idempotent start (NEW: bundled channel-core + lark-platform). Safe
# to call from a skill, from cron, or manually.
#   - If daemon already running (HTTP /api/status responds): print status, exit 0
#   - Else: double-fork daemon.sh into background + detach
#   - flock inside daemon.sh enforces singleton (else port-bind EADDRINUSE does)
set -u
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"  # launchd/cron PATH lacks Homebrew/nvm → else `node: not found` on keepalive cold-start

HOST="127.0.0.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # canonical: ~/.knowledge-assistant/channels/lark-daemon
# Port = config.yaml channels.lark.port (single source of truth). Resolve KA_HOME
# from this dir (KA_HOME/channels/<kind>-daemon), then read the shared config;
# fall back to 9876 only if the entry is absent.
: "${KA_HOME:=$(cd "$ROOT/../.." && pwd)}"
CONFIG_YAML="${KA_CONFIG:-${KA_CONFIG_DIR:-$KA_HOME/config}/config.yaml}"
PORT="$(awk -v kind=lark '{match($0,/^ */);i=RLENGTH} i==0{k=$0;sub(/:.*/,"",k);gsub(/[ \t]/,"",k);c=(k=="channels")?1:0;s="";next} c&&i==2{k=$0;gsub(/^ +/,"",k);sub(/:.*/,"",k);gsub(/[ \t]/,"",k);s=k;next} c&&s==kind&&i>=4&&/port[ \t]*:/{v=$0;sub(/.*port[ \t]*:[ \t]*/,"",v);gsub(/[^0-9]/,"",v);if(v!=""){print v;exit}}' "$CONFIG_YAML" 2>/dev/null)"
[ -n "$PORT" ] || PORT="9876"
LOG="$ROOT/daemon.stdout.log"

# 1. Probe — is it already up?
status_resp=$(curl -sf --max-time 2 "http://$HOST:$PORT/api/status" 2>/dev/null || true)
if [ -n "$status_resp" ]; then
  echo "✓ already running"
  echo "$status_resp"
  exit 0
fi

# Race guard: a process LISTENING on the port IS the daemon (warming or ready) even if
# /api/status didn't answer in the brief startup window — treat it as up. The port bind
# is the singleton (macOS has no flock), and the daemon's own EADDRINUSE exit prevents
# duplicates. No orphan-killing cleanup here: it was redundant with the port singleton and
# caused a race where two concurrent `start` invocations killed each other's daemon.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✓ already running (port $PORT bound)"
  exit 0
fi

# 2. Not up — launch detached. A macOS LaunchAgent cleans up child processes
# in its own coalition when the job exits, so use a separate transient launchd
# job instead of plain nohup when launchctl is available.
if command -v setsid >/dev/null 2>&1; then
  nohup setsid bash "$ROOT/daemon.sh" </dev/null >>"$LOG" 2>&1 &
elif command -v launchctl >/dev/null 2>&1; then
  LABEL="com.knowledge-assistant.ka.channel.lark"
  launchctl remove "$LABEL" >/dev/null 2>&1 || true
  launchctl submit -l "$LABEL" -o "$LOG" -e "$LOG" -- /bin/bash "$ROOT/daemon.sh"
else
  nohup bash "$ROOT/daemon.sh" </dev/null >>"$LOG" 2>&1 &
fi
disown 2>/dev/null || true

# 3. Wait up to ~5s for it to come up
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.5
  status_resp=$(curl -sf --max-time 1 "http://$HOST:$PORT/api/status" 2>/dev/null || true)
  if [ -n "$status_resp" ]; then
    echo "✓ started (after ${i} attempts)"
    echo "$status_resp"
    exit 0
  fi
done

echo "✗ failed to start within 5s; see $LOG for details"
tail -20 "$LOG" 2>/dev/null || true
exit 1
