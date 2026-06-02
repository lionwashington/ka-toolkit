#!/bin/bash
# ka restart — stop, pause, start.
set -euo pipefail

THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$THIS_DIR/common.sh"

# P2: start/stop retired into the workshop verb dispatcher.
log_info "restart: stopping..."
"$CLI_DIR/workshop.sh" stop || log_warn "stop returned non-zero (continuing)"

sleep 2

log_info "restart: starting..."
exec "$CLI_DIR/workshop.sh" "$@"
