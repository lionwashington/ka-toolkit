#!/bin/bash
# tmux-helpers.sh — shared tmux utilities for ops scripts.
# Source this file: `source "$(dirname "$0")/tmux-helpers.sh"`

TMUX_BIN="${TMUX_BIN:-$(command -v tmux || echo /opt/homebrew/bin/tmux)}"

tmux_require() {
    if [ ! -x "$TMUX_BIN" ]; then
        echo "ERROR: tmux not found at $TMUX_BIN" >&2
        return 1
    fi
}

tmux_pane_exists() {
    local target="$1"
    "$TMUX_BIN" list-panes -a -F "#{session_name}:#{window_index}.#{pane_index}" 2>/dev/null \
        | grep -qx "$target"
}

tmux_pane_cwd() {
    local target="$1"
    "$TMUX_BIN" display-message -p -t "$target" "#{pane_current_path}" 2>/dev/null
}

tmux_pane_pid() {
    local target="$1"
    "$TMUX_BIN" display-message -p -t "$target" "#{pane_pid}" 2>/dev/null
}

# tmux_pane_for_channel <channel-name>
# Print the pane target (session:window.pane) whose @ka_channel == <channel-name>,
# searching ALL sessions. Prints nothing (and returns 1) if no pane matches —
# callers treat "no match" as fail-closed (do nothing). Replaces the retired
# detect-main-pane.sh: identity is the channel name, not a hard-wired "main".
tmux_pane_for_channel() {
    local channel="$1"
    [ -n "$channel" ] || return 1
    local target
    target="$("$TMUX_BIN" list-panes -a \
        -F '#{session_name}:#{window_index}.#{pane_index}|#{@ka_channel}' 2>/dev/null \
        | awk -F'|' -v c="$channel" '$2 == c { print $1; exit }')"
    [ -n "$target" ] || return 1
    echo "$target"
}

log_ts() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $*"
}
