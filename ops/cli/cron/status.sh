#!/bin/bash
# ka cron status — one-line health summary used by `ka status`.
set -euo pipefail
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$THIS_DIR/_common.sh"

load_backend
cron_load_jobs

total="${#CRON_JOB_NAMES[@]}"
enabled=0; ok=0; failed=0; missing=0
for name in "${CRON_JOB_NAMES[@]+"${CRON_JOB_NAMES[@]}"}"; do
    if cron_job_is_enabled "$name"; then
        enabled=$((enabled+1))
        if backend::is_loaded "$name" 2>/dev/null; then
            ok=$((ok+1))
        else
            missing=$((missing+1))
        fi
    fi
done

# orphans
orphans=0
while IFS= read -r installed_name; do
    [ -z "$installed_name" ] && continue
    cron_job_exists "$installed_name" || orphans=$((orphans+1))
done < <(backend::list_installed 2>/dev/null)

printf 'cron: %d jobs (%d enabled, %d ok / %d missing-unit, %d orphan-unit)\n' \
    "$total" "$enabled" "$ok" "$missing" "$orphans"

[ "$missing" -eq 0 ] && [ "$orphans" -eq 0 ]
