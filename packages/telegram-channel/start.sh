#!/bin/bash
# telegram-channel idempotent start. Safe to call from a skill, from cron, or
# manually. Behavior:
#
#   - If daemon already running (HTTP /api/status responds): print status, exit 0
#   - Else: double-fork daemon.sh into background and detach
#   - flock inside daemon.sh enforces singleton — race conditions handled by
#     the OS-level lock, not by this script
set -u
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"

HOST="127.0.0.1"
PORT="9877"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # self-contained: dir of this script (canonical: ~/.knowledge-assistant/runtime/daemon)
LOG="$ROOT/daemon.stdout.log"

# 1. Probe — is it already up?
status_resp=$(curl -sf --max-time 2 "http://$HOST:$PORT/api/status" 2>/dev/null || true)
if [ -n "$status_resp" ]; then
  echo "✓ already running"
  echo "$status_resp"
  exit 0
fi

# 1b. Defensive cleanup: kill any orphan daemon node process not under flock.
# D0: the daemon is the bundled `node … daemon.mjs` launched by daemon.sh.
BUNDLE="${KA_DAEMON_BUNDLE:-$ROOT/daemon.mjs}"
LOCKED_PID=$(/usr/bin/lsof -t -F p "$ROOT/.daemon.lock" 2>/dev/null | sed 's/^p//' | head -1 || true)
for pid in $(pgrep -f "node $BUNDLE" || true); do
  if [ "$pid" != "$LOCKED_PID" ] && [ "$pid" != "$$" ]; then
    echo "killing orphan daemon pid=$pid (not under flock)"
    kill "$pid" 2>/dev/null || true
  fi
done

# 2. Not up — launch in background, detached from current terminal.
# `setsid` detaches into a new session (Linux); macOS has no setsid, so fall
# back to plain nohup + disown (flock in daemon.sh still enforces singleton).
if command -v setsid >/dev/null 2>&1; then
  nohup setsid bash "$ROOT/daemon.sh" </dev/null >>"$LOG" 2>&1 &
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
