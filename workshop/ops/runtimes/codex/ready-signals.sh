#!/bin/bash

runtime::ready_match() {
    local content="$1"
    # A modal can leave the ordinary prompt/status strip visible underneath.
    # App Server liveness and those background hints do not mean TUI readiness.
    if printf '%s' "$content" | grep -qiE 'Hooks need review|Trust all and continue|Continue without trusting'; then
        return 1
    fi
    if printf '%s' "$content" | grep -qE '(^|\n)[[:space:]]*›[[:space:]]*($|\n)'; then
        printf 'prompt-chevron'
        return 0
    fi
    if printf '%s' "$content" | grep -qiE '\? for shortcuts|context left|ask codex'; then
        printf 'status'
        return 0
    fi
    return 1
}
