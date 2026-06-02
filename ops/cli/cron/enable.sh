#!/bin/bash
# ka cron enable <name>
set -euo pipefail
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$THIS_DIR/_common.sh"

NAME="${1:?ka cron enable <name>}"
cron_load_jobs
cron_job_exists "$NAME" || { echo "ka cron: unknown job '$NAME'" >&2; exit 2; }
cron_yaml_rewrite set_field "$NAME" enabled true
log_ok "enabled '$NAME' in $CRON_YAML"
"$THIS_DIR/install.sh" --only "$NAME"
