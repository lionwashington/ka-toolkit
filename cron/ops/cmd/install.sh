#!/bin/bash
# ka cron install — sync cron.yaml → OS units. Idempotent.
#
# Flags:
#   --dry-run        Show what would happen; don't touch OS.
#   --only <name>    Install only one named job (used by `ka cron add`).
set -euo pipefail
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$THIS_DIR/_common.sh"

DRY_RUN=0
ONLY=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --only)    ONLY="$2"; shift 2 ;;
        -h|--help) echo "ka cron install [--dry-run] [--only <name>]"; exit 0 ;;
        *) echo "ka cron install: unknown flag '$1'" >&2; exit 2 ;;
    esac
done

cron_yaml_exists || { log_warn "no cron.yaml; nothing to install"; exit 0; }
load_backend
cron_load_jobs

mkdir -p "$CRON_LOG_DIR"

installed=0
skipped=0
disabled=0
failed=0

for name in "${CRON_JOB_NAMES[@]+"${CRON_JOB_NAMES[@]}"}"; do
    [ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && continue

    schedule="$(cron_job_field "$name" schedule || true)"
    if [ -z "$schedule" ]; then
        log_warn "$name: missing schedule in yaml; skipping"
        failed=$((failed+1)); continue
    fi

    if ! cron_job_is_enabled "$name"; then
        log_dim "$name: disabled — uninstalling OS unit if present"
        [ "$DRY_RUN" -eq 0 ] && backend::uninstall "$name" 2>/dev/null || true
        disabled=$((disabled+1)); continue
    fi

    log_file="$CRON_LOG_DIR/${name}.log"

    # env_* collection
    env_str=""
    for i in "${!CRON_JOB_REC_KEYS[@]}"; do
        k="${CRON_JOB_REC_KEYS[$i]}"
        case "$k" in
            "$name|env_"*)
                ek="${k#$name|env_}"
                v="${CRON_JOB_REC_VALS[$i]}"
                env_str="${env_str}${ek}=${v};"
                ;;
        esac
    done

    # Export the job's unit inputs so the backend can build its unit. launchd reads
    # them via plist-gen (below); the crontab backend reads them directly in
    # backend::install (it ignores the generated plist).
    export KA_ROOT KA_CRON_NAME="$name" KA_CRON_SCHEDULE="$schedule" \
           KA_CRON_LOG="$log_file" KA_CRON_ENV="$env_str"
    # Generate plist to temp file (launchd unit; ignored by the crontab backend).
    tmp_plist="$(mktemp -t ka-cron-XXXXXX).plist"
    if ! bash "$CRON_PLIST_GEN" > "$tmp_plist" 2>/dev/null; then
        log_err "$name: plist-gen failed"
        rm -f "$tmp_plist"
        failed=$((failed+1)); continue
    fi

    dst="$(backend::plist_path "$name")"
    if [ -f "$dst" ] && cmp -s "$tmp_plist" "$dst" && backend::is_loaded "$name" 2>/dev/null; then
        log_dim "$name: already in sync"
        rm -f "$tmp_plist"
        skipped=$((skipped+1)); continue
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
        log_info "$name: would install → $dst"
        rm -f "$tmp_plist"
        continue
    fi

    if backend::install "$name" "$tmp_plist"; then
        log_ok "$name: installed"
        installed=$((installed+1))
    else
        log_err "$name: install failed"
        failed=$((failed+1))
    fi
    rm -f "$tmp_plist"
done

if [ -z "$ONLY" ]; then
    # Detect orphans: OS units without a yaml entry
    while IFS= read -r installed_name; do
        [ -z "$installed_name" ] && continue
        if ! cron_job_exists "$installed_name"; then
            log_warn "orphan OS unit: $installed_name (not in yaml; run 'ka cron remove $installed_name' to clean)"
        fi
    done < <(backend::list_installed 2>/dev/null)
fi

log_info "install summary: ${installed} installed / ${skipped} in-sync / ${disabled} disabled / ${failed} failed"
[ "$failed" -eq 0 ]
