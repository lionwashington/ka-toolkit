#!/bin/bash
# lark-channel status check. Returns exit 0 + JSON if alive, exit 1 if dead.
set -u
HOST="127.0.0.1"
PORT="9876"
r=$(curl -sf --max-time 2 "http://$HOST:$PORT/api/status" 2>/dev/null || true)
if [ -n "$r" ]; then
  echo "$r"
  exit 0
fi
echo '{"ok":false,"error":"daemon not running"}'
exit 1
