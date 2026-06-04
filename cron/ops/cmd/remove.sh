#!/bin/bash
# ka cron remove <name> — uninstall OS unit + remove from yaml.
set -euo pipefail
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$THIS_DIR/_common.sh"

PURGE_LOGS=0
NAME=""
while [ $# -gt 0 ]; do
    case "$1" in
        --purge-logs) PURGE_LOGS=1; shift ;;
        -h|--help) echo "ka cron remove <name> [--purge-logs]"; exit 0 ;;
        --*) echo "ka cron remove: unknown flag '$1'" >&2; exit 2 ;;
        *) NAME="$1"; shift ;;
    esac
done
[ -n "$NAME" ] || { echo "ka cron remove: <name> required" >&2; exit 2; }

load_backend
cron_load_jobs
if ! cron_job_exists "$NAME"; then
    log_warn "job '$NAME' not in cron.yaml — checking OS..."
fi

# Uninstall OS unit (idempotent)
backend::uninstall "$NAME" || true
log_ok "uninstalled OS unit for '$NAME' (if present)"

# Remove from yaml
cron_yaml_rewrite remove "$NAME"
log_ok "removed '$NAME' from $CRON_YAML"

if [ "$PURGE_LOGS" -eq 1 ]; then
    rm -f "$CRON_LOG_DIR/${NAME}.log" && log_info "purged log"
fi
