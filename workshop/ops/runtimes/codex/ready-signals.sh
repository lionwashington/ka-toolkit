#!/bin/bash

runtime::ready_match() {
    local content="$1"
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
