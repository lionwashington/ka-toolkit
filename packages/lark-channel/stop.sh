#!/bin/bash
# lark-channel graceful stop. POSTs /api/shutdown; daemon exits cleanly.
set -u
HOST="127.0.0.1"
PORT="9876"
r=$(curl -sf --max-time 2 -X POST "http://$HOST:$PORT/api/shutdown" 2>/dev/null || true)
if [ -n "$r" ]; then
  echo "$r"
  exit 0
fi
echo '{"ok":false,"error":"daemon not running or unreachable"}'
exit 1
