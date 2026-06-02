#!/bin/bash
# ka cron disable <name>
set -euo pipefail
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$THIS_DIR/_common.sh"

NAME="${1:?ka cron disable <name>}"
load_backend
cron_load_jobs
cron_job_exists "$NAME" || { echo "ka cron: unknown job '$NAME'" >&2; exit 2; }
cron_yaml_rewrite set_field "$NAME" enabled false
backend::uninstall "$NAME" || true
log_ok "disabled '$NAME' + uninstalled OS unit"
