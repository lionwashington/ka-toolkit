#!/bin/bash
# Confirm Claude Code's development-channel gate after its marker appears.

runtime::post_launch() {
    local pane="$1" name="$2"
    local timeout="${KA_GATE_TIMEOUT:-18}"
    local waited=0 cap tmux_bin="${TMUX_BIN:-tmux}"
    while [ "$waited" -lt "$timeout" ]; do
        cap="$("$tmux_bin" capture-pane -p -t "$pane" 2>/dev/null || true)"
        if printf '%s' "$cap" | grep -qF "I am using this for local development" \
           || printf '%s' "$cap" | grep -qF "Enter to confirm"; then
            "$tmux_bin" send-keys -t "$pane" Enter
            log_ts "auto-confirmed dev-channels gate on pane $pane ($name)"
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    log_warn "dev-channels gate not detected on pane $pane ($name) within ${timeout}s — skipping"
    return 0
}
