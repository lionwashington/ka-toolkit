#!/bin/bash
# ka kb reindex — (re)build the LanceDB index via the running kb-retrieval daemon,
# reusing its already-loaded embedding model (no 2GB reload).
#   ka kb reindex          incremental: only files changed since last index (+ drop vanished)
#   ka kb reindex --full   drop + rebuild everything (slow; CPU embed of the whole KB)
# This is a thin curl to the daemon's /api/reindex — no native deps here. distill calls
# the same endpoint after writing topics, so new knowledge shows up in kb_search in seconds.
set -u
: "${KA_HOME:=$HOME/.knowledge-assistant}"
HOST="127.0.0.1"
CONFIG_YAML="${KA_CONFIG:-${KA_CONFIG_DIR:-$KA_HOME/config}/config.yaml}"
PORT="$(awk '
  { match($0,/^ */); i=RLENGTH }
  i==0 { k=$0; sub(/:.*/,"",k); gsub(/[ \t]/,"",k); r=(k=="retrieval")?1:0; d=0; next }
  r&&i==2 { k=$0; gsub(/^ +/,"",k); sub(/:.*/,"",k); gsub(/[ \t]/,"",k); d=(k=="daemon")?1:0; next }
  r&&d&&i>=4&&/port[ \t]*:/ { v=$0; sub(/.*port[ \t]*:[ \t]*/,"",v); gsub(/[^0-9]/,"",v); if(v!=""){print v; exit} }
' "$CONFIG_YAML" 2>/dev/null)"
[ -n "$PORT" ] || PORT="7705"

QS=""; MAXT=300
if [ "${1:-}" = "--full" ]; then QS="?full=1"; MAXT=3600; fi

r=$(curl -sf --max-time "$MAXT" -X POST "http://$HOST:$PORT/api/reindex$QS" 2>/dev/null || true)
if [ -n "$r" ]; then
  echo "$r"
  echo "$r" | grep -q '"ok":true' && exit 0 || exit 1
fi
echo '{"ok":false,"error":"kb-retrieval daemon not reachable — start it: ka kb start"}'
exit 1
