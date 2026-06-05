#!/bin/bash
# ka kb — knowledge-base operations (clustered subcommands).
#   ka kb retrieval [start|stop|restart|status]   the shared LanceDB retrieval daemon (kb_search backend)
#   ka kb reindex   [--full]                       (re)build the kb_search index (incremental | full)
#   ka kb distill   [status]                        background distillation (status shows the last run)
set -uo pipefail
: "${KA_HOME:=$HOME/.knowledge-assistant}"
OPS="$KA_HOME/kb/ops"

SUB="${1:-}"; [ $# -gt 0 ] && shift || true
case "$SUB" in
    retrieval) exec "$OPS/kb-retrieval.sh" "$@" ;;
    reindex)   exec "$OPS/kb-reindex.sh" "$@" ;;
    distill)
        # Background distill is the only mode (synchronous distill lives inside
        # /kb distill --foreground). `ka kb distill status` shows the last run.
        if [ "${1:-}" = "status" ]; then
            shift
            exec "$OPS/distill-status.sh" "$@"
        fi
        # Tolerate a legacy --background flag (background is the default now).
        FILTERED=()
        for arg in "$@"; do [ "$arg" = "--background" ] && continue; FILTERED+=("$arg"); done
        exec "$OPS/distill-bg.sh" ${FILTERED[@]+"${FILTERED[@]}"}
        ;;
    ''|-h|--help|help)
        echo "ka kb — knowledge-base ops:"
        echo "  ka kb retrieval [start|stop|restart|status]   shared LanceDB retrieval daemon"
        echo "  ka kb reindex [--full]                         (re)build the kb_search index"
        echo "  ka kb distill [status]                         background distillation"
        ;;
    *)
        echo "ka kb: unknown subcommand '$SUB' (retrieval|reindex|distill)" >&2
        exit 2
        ;;
esac
