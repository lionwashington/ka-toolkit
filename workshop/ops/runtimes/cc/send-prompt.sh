#!/bin/bash
# cc/send-prompt.sh — CC adapter: paste + submit a prompt into a tmux pane.
#
# See docs/components/workshop-runtime-interface.md §runtime::inject_prompt.

# runtime::inject_prompt <tmux_target> <text>
# Pastes `text` literally and submits. Two CC-specific quirks baked in:
#   * `send-keys Enter` (tmux alias) gets dropped by CC's TUI under some
#     locale/terminal combos. `C-m` (literal 0x0D) is what CC's input reader
#     actually listens for.
#   * A 0.5s sleep between paste and Return gives the TUI time to finish
#     processing the paste — otherwise Return races the paste and is ignored.
runtime::inject_prompt() {
    local target="$1" text="$2"
    local tmux_bin="${TMUX_BIN:-tmux}"
    "$tmux_bin" send-keys -t "$target" -l "$text"
    sleep 0.5
    "$tmux_bin" send-keys -t "$target" C-m
}
