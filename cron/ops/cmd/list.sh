#!/bin/bash
# ka cron list — show all declared jobs + last-run status.
set -euo pipefail
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$THIS_DIR/_common.sh"

load_backend

if ! cron_yaml_exists; then
    echo "(no cron.yaml; run 'ka cron add' or 'ka cron import' to create)"
    exit 0
fi

cron_load_jobs

if [ "${#CRON_JOB_NAMES[@]}" -eq 0 ]; then
    echo "(cron.yaml has no jobs; add with 'ka cron add')"
    exit 0
fi

printf '%-22s %-18s %-14s %-20s %s\n' "NAME" "SCHEDULE" "KIND" "LAST RUN" "STATUS"
for name in "${CRON_JOB_NAMES[@]}"; do
    schedule="$(cron_job_field "$name" schedule || true)"
    kind="$(cron_job_field "$name" kind || echo shell)"
    enabled="$(cron_job_field "$name" enabled || echo true)"
    log="$CRON_LOG_DIR/${name}.log"

    last_run="never"
    status="disabled"
    if cron_job_is_enabled "$name"; then
        if backend::is_loaded "$name" 2>/dev/null; then
            status="ok"
        else
            status="missing-unit"
        fi
    fi
    if [ -f "$log" ]; then
        last_run="$(date -r "$log" '+%Y-%m-%d %H:%M' 2>/dev/null || echo unknown)"
        # parse last exit line
        last_exit="$(grep -E '^=== .* exit=' "$log" | tail -1 || true)"
        if [ -n "$last_exit" ]; then
            rc="$(printf '%s' "$last_exit" | sed -n 's/.*exit=\([0-9]*\).*/\1/p')"
            if [ -n "$rc" ] && [ "$rc" != "0" ]; then
                status="failed(rc=$rc)"
            fi
        fi
    fi
    printf '%-22s %-18s %-14s %-20s %s\n' "$name" "$schedule" "$kind" "$last_run" "$status"
done
