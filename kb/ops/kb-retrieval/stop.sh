#!/bin/bash
# kb-retrieval graceful stop. POSTs /api/shutdown; the daemon exits cleanly.
set -u
HOST="127.0.0.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${KA_HOME:=$(cd "$ROOT/../../.." && pwd)}"
CONFIG_YAML="${KA_CONFIG:-${KA_CONFIG_DIR:-$KA_HOME/config}/config.yaml}"
PORT="$(awk '
  { match($0,/^ */); i=RLENGTH }
  i==0 { k=$0; sub(/:.*/,"",k); gsub(/[ \t]/,"",k); r=(k=="retrieval")?1:0; d=0; next }
  r&&i==2 { k=$0; gsub(/^ +/,"",k); sub(/:.*/,"",k); gsub(/[ \t]/,"",k); d=(k=="daemon")?1:0; next }
  r&&d&&i>=4&&/port[ \t]*:/ { v=$0; sub(/.*port[ \t]*:[ \t]*/,"",v); gsub(/[^0-9]/,"",v); if(v!=""){print v; exit} }
' "$CONFIG_YAML" 2>/dev/null)"
[ -n "$PORT" ] || PORT="7705"
# shellcheck source=daemon-process.sh
source "$ROOT/daemon-process.sh"
pid="$(kb_daemon_pid "$PORT" 2>/dev/null || true)"
r=$(curl -sf --max-time 2 -X POST "http://$HOST:$PORT/api/shutdown" 2>/dev/null || true)
if [ -n "$r" ]; then
  echo "$r"
  if [ -n "$pid" ] && ! kb_wait_pid_exit "$pid" 50; then
    kb_stop_daemon_pid "$pid" || { echo '{"ok":false,"error":"daemon acknowledged shutdown but did not exit"}' >&2; exit 1; }
  fi
  rm -f "$KA_HOME/state/kb-retrieval-health"
  exit 0
fi
if [ -n "$pid" ]; then
  echo "warning: shutdown API unreachable; stopping validated daemon pid $pid" >&2
  kb_stop_daemon_pid "$pid" || { echo '{"ok":false,"error":"failed to stop unresponsive daemon"}'; exit 1; }
  rm -f "$KA_HOME/state/kb-retrieval-health"
  echo '{"ok":true,"shutting_down":true,"forced":true}'
  exit 0
fi
echo '{"ok":false,"error":"daemon not running or unreachable"}'
exit 1
