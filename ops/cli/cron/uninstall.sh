#!/bin/bash
# ka cron uninstall — remove all ka cron OS units. Leaves yaml intact.
set -euo pipefail
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$THIS_DIR/_common.sh"

load_backend
removed=0
while IFS= read -r name; do
    [ -z "$name" ] && continue
    backend::uninstall "$name" && removed=$((removed+1))
done < <(backend::list_installed 2>/dev/null)
log_ok "uninstalled $removed OS unit(s). cron.yaml untouched."
