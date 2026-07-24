#!/bin/bash
# ka kb — knowledge-base operations (clustered subcommands).
#   ka kb start|stop|restart|status   the shared LanceDB retrieval daemon (kb_search backend)
#   ka kb reindex [--full] [--mode embedding|fts5|all]
#   ka kb benchmark <fixture> [embedding|fts5|both]
#   ka kb distill   [status]           background distillation (status shows the last run)
set -uo pipefail
: "${KA_HOME:=$HOME/.knowledge-assistant}"
OPS="$KA_HOME/kb/ops"

SUB="${1:-}"; [ $# -gt 0 ] && shift || true
case "$SUB" in
    start|stop|restart|status) exec "$OPS/kb-retrieval.sh" "$SUB" "$@" ;;
    reindex)   exec "$OPS/kb-reindex.sh" "$@" ;;
    benchmark) exec node "$OPS/kb-benchmark.mjs" "$@" ;;
    lint)      exec "$OPS/kb-lint.sh" "$@" ;;
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
        echo "  ka kb start|stop|restart|status   the kb retrieval daemon (kb_search backend)"
        echo "  ka kb reindex [--full] [--mode embedding|fts5|all]"
        echo "  ka kb benchmark <fixture> [embedding|fts5|both]"
        echo "  ka kb distill [status]             background distillation"
        echo "  ka kb lint [--json|--fix]          read-only KB self-check (dead links / orphans / frontmatter)"
        ;;
    *)
        echo "ka kb: unknown subcommand '$SUB' (start|stop|restart|status|reindex|benchmark|distill|lint)" >&2
        exit 2
        ;;
esac
