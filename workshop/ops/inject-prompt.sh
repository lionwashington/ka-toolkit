#!/bin/bash
# inject-prompt.sh — send a prompt + Enter into a specific tmux pane.
#
# Usage: inject-prompt.sh <pane-target> "<prompt text>"
#
# FAIL-CLOSED: the caller resolves and passes an explicit target pane (derived
# from config.yaml channels.inject → tmux_pane_for_channel). There is NO
# auto-detect fallback — if the target is missing or the pane doesn't exist we
# do nothing rather than guess. (Replaces the old behavior that hard-wired
# detect-main-pane.sh to find @ka_channel=main.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${KA_HOME:=$HOME/.knowledge-assistant}"
source "$KA_HOME/shared/ops/common.sh"
# shellcheck source=tmux-helpers.sh
source "$SCRIPT_DIR/tmux-helpers.sh"
# shellcheck source=runtimes/dispatch.sh
source "$KA_RUNTIMES_DIR/dispatch.sh"

tmux_require

TARGET="${1:-}"
PROMPT="${2:-}"
if [ -z "$TARGET" ] || [ -z "$PROMPT" ]; then
    echo "Usage: $0 <pane-target> \"<prompt text>\"" >&2
    exit 64
fi

if ! tmux_pane_exists "$TARGET"; then
    log_ts "ERROR: pane $TARGET not found — skipping injection" >&2
    exit 2
fi

log_ts "Injecting prompt into $TARGET: ${PROMPT:0:80}..."
RUNTIME="$("$TMUX_BIN" show-options -p -v -t "$TARGET" @ka_runtime 2>/dev/null || true)"
[ -n "$RUNTIME" ] || RUNTIME="cc"
runtime_load "$RUNTIME" || {
    log_ts "ERROR: unsupported runtime '$RUNTIME' for pane $TARGET" >&2
    exit 78
}
runtime::inject_prompt "$TARGET" "$PROMPT"
log_ts "Prompt sent to $TARGET."
