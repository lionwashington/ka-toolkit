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
# shellcheck source=tmux-helpers.sh
source "$SCRIPT_DIR/tmux-helpers.sh"

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
"$TMUX_BIN" send-keys -t "$TARGET" -l "$PROMPT"
"$TMUX_BIN" send-keys -t "$TARGET" Enter
log_ts "Prompt sent to $TARGET."
