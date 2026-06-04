#!/bin/bash
# lark-channel status check. Returns exit 0 + JSON if alive, exit 1 if dead.
set -u
HOST="127.0.0.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Port = config.yaml channels.lark.port (fall back to 9876 if absent).
: "${KA_HOME:=$(cd "$ROOT/../.." && pwd)}"
CONFIG_YAML="${KA_CONFIG:-${KA_CONFIG_DIR:-$KA_HOME/config}/config.yaml}"
PORT="$(awk -v kind=lark '{match($0,/^ */);i=RLENGTH} i==0{k=$0;sub(/:.*/,"",k);gsub(/[ \t]/,"",k);c=(k=="channels")?1:0;s="";next} c&&i==2{k=$0;gsub(/^ +/,"",k);sub(/:.*/,"",k);gsub(/[ \t]/,"",k);s=k;next} c&&s==kind&&i>=4&&/port[ \t]*:/{v=$0;sub(/.*port[ \t]*:[ \t]*/,"",v);gsub(/[^0-9]/,"",v);if(v!=""){print v;exit}}' "$CONFIG_YAML" 2>/dev/null)"
[ -n "$PORT" ] || PORT="9876"
r=$(curl -sf --max-time 2 "http://$HOST:$PORT/api/status" 2>/dev/null || true)
if [ -n "$r" ]; then
  echo "$r"
  exit 0
fi
echo '{"ok":false,"error":"daemon not running"}'
exit 1
