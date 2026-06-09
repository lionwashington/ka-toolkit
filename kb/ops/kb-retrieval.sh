#!/bin/bash
# ka kb {start|stop|restart|status} — operate the shared LanceDB HTTP retrieval
# daemon (the kb-retrieval service; the command face is `ka kb`, internals keep
# the kb-retrieval name).
# The daemon + its launch scripts live in the deployed MCP dir $KA_HOME/kb/mcp/kb
# (laid down by ./install.sh deploy_kb_mcp). Port = config.yaml
# retrieval.daemon.port (default 7705). This is the type:http backend CCs register
# against; one resident process holds the LanceDB connection + the embedding model
# loaded once, shared across all CCs.
set -euo pipefail
: "${KA_HOME:=$HOME/.knowledge-assistant}"
source "$KA_HOME/shared/ops/common.sh"

DIR="$KA_HOME/kb/mcp/kb"

VERB="${1:-status}"; [ $# -gt 0 ] && shift || true
case "$VERB" in
    start)
        [ -x "$DIR/start.sh" ] || { log_err "kb-retrieval not deployed at $DIR (run ./install.sh --only node-mcp)"; exit 1; }
        log_info "starting kb-retrieval daemon (model warmup may take ~10-50s on cold start)…"
        exec "$DIR/start.sh"
        ;;
    stop)
        [ -x "$DIR/stop.sh" ] || { log_err "kb-retrieval not deployed at $DIR"; exit 1; }
        log_info "stopping kb-retrieval daemon…"
        exec "$DIR/stop.sh"
        ;;
    restart)
        [ -x "$DIR/start.sh" ] || { log_err "kb-retrieval not deployed at $DIR (run ./install.sh --only node-mcp)"; exit 1; }
        log_info "restarting kb-retrieval daemon…"
        [ -x "$DIR/stop.sh" ] && "$DIR/stop.sh" >/dev/null 2>&1 || true
        sleep 1
        exec "$DIR/start.sh"
        ;;
    status)
        [ -x "$DIR/status.sh" ] || { log_err "kb-retrieval not deployed at $DIR"; exit 1; }
        exec "$DIR/status.sh"
        ;;
    *)
        echo "ka kb: unknown verb '$VERB' (start|stop|restart|status)" >&2
        exit 2
        ;;
esac
