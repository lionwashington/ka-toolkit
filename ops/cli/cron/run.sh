#!/bin/bash
# ka cron run <name> — trigger a job immediately, foreground output.
set -euo pipefail
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$THIS_DIR/_common.sh"

NAME="${1:?ka cron run <name>}"
cron_load_jobs
cron_job_exists "$NAME" || { echo "ka cron: unknown job '$NAME'" >&2; exit 2; }
exec bash "$CRON_RUNNER" "$NAME" --foreground
