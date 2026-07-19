#!/bin/bash
# Runtime-neutral pane entrypoint. Runtime-specific process setup lives under
# workshop/ops/runtimes/<runtime>/.

set -euo pipefail

RUNTIME="${1:?runtime required}"
shift

: "${KA_HOME:=$HOME/.knowledge-assistant}"
source "$KA_HOME/shared/ops/common.sh"
# shellcheck source=runtimes/dispatch.sh
source "$KA_RUNTIMES_DIR/dispatch.sh"

runtime_load "$RUNTIME" || exit 78
ENTRYPOINT="$(runtime::launch_pane_script)"
[ -x "$ENTRYPOINT" ] || {
    echo "start-pane: runtime '$RUNTIME' entrypoint is not executable: $ENTRYPOINT" >&2
    exit 78
}
exec "$ENTRYPOINT" "$@"
