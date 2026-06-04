#!/bin/bash
# telegram-channel graceful stop. POSTs /api/shutdown; daemon exits cleanly.
set -u
HOST="127.0.0.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="$(sed -n 's/.*"http_port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ROOT/config.json" 2>/dev/null | head -1)"
[ -n "$PORT" ] || PORT="9877"
r=$(curl -sf --max-time 2 -X POST "http://$HOST:$PORT/api/shutdown" 2>/dev/null || true)
if [ -n "$r" ]; then
  echo "$r"
  exit 0
fi
echo '{"ok":false,"error":"daemon not running or unreachable"}'
exit 1
