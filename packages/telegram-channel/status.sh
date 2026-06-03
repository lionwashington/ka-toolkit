#!/bin/bash
# telegram-channel status check. Returns exit 0 + JSON if alive, exit 1 if dead.
set -u
HOST="127.0.0.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="$(sed -n 's/.*"http_port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ROOT/config.json" 2>/dev/null | head -1)"
[ -n "$PORT" ] || PORT="9877"
r=$(curl -sf --max-time 2 "http://$HOST:$PORT/api/status" 2>/dev/null || true)
if [ -n "$r" ]; then
  echo "$r"
  exit 0
fi
echo '{"ok":false,"error":"daemon not running"}'
exit 1
