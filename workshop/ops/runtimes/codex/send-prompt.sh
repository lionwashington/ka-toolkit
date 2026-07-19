#!/bin/bash

runtime::inject_prompt() {
    local target="$1" text="$2"
    local tmux_bin="${TMUX_BIN:-tmux}"
    "$tmux_bin" send-keys -t "$target" -l "$text"
    sleep 0.3
    "$tmux_bin" send-keys -t "$target" C-m
}
