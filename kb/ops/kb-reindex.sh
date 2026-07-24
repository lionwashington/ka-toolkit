#!/bin/bash
# ka kb reindex — (re)build one or both search indexes via the retrieval daemon.
#   ka kb reindex                         incremental active/configured mode
#   ka kb reindex --mode fts5             incremental low-memory FTS5 index
#   ka kb reindex --mode embedding --full full LanceDB embedding rebuild
#   ka kb reindex --mode all              update both indexes (benchmark/switch prep)
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

FULL=0; MODE=""; MAXT=300
while [ "$#" -gt 0 ]; do
  case "$1" in
    --full) FULL=1; MAXT=3600 ;;
    --mode)
      shift
      MODE="${1:-}"
      case "$MODE" in embedding|fts5|all) ;; *)
        echo "usage: ka kb reindex [--full] [--mode embedding|fts5|all]" >&2
        exit 2
      esac
      ;;
    *)
      echo "usage: ka kb reindex [--full] [--mode embedding|fts5|all]" >&2
      exit 2
      ;;
  esac
  shift
done

QS="?"
[ "$FULL" = 1 ] && QS="${QS}full=1&"
[ -n "$MODE" ] && QS="${QS}mode=${MODE}&"
QS="${QS%[?&]}"

r=$(curl -sf --max-time "$MAXT" -X POST "http://$HOST:$PORT/api/reindex$QS" 2>/dev/null || true)
if [ -n "$r" ]; then
  echo "$r"
  echo "$r" | grep -q '"ok":true' && exit 0 || exit 1
fi
echo '{"ok":false,"error":"kb-retrieval daemon not reachable — start it: ka kb start"}'
exit 1
