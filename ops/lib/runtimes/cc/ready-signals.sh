#!/bin/bash
# cc/ready-signals.sh — CC adapter: ready-state predicates.
#
# Pure predicates on a captured-pane string. No side effects, no tmux calls.
# See ops/lib/runtimes/interface.md §runtime::ready_match.

# runtime::ready_match <captured_text>
# Exit 0 if the text looks like a booted-and-idle CC TUI, 1 otherwise.
# On success echoes a short tag describing which signal matched
# (prompt-caret | prompt-bar | status | prompt-caret+status | …) — callers
# can ignore or surface it in verbose logging.
#
# Heuristic (see wait-ready.sh header for why cksum stability was dropped):
#   1. Current TUI renders `❯` on its own line.
#   2. Legacy / fixture shape uses `│ >`.
#   3. Bottom status-line hint (`ctrl+t to show` / `shift+… to expand` /
#      `permissions o` / `accept edits`) only appears once CC is past init.
# Either a prompt marker OR a status-line hint is sufficient; the caller
# handles the "signal present for N seconds" stability window separately.
runtime::ready_match() {
    local content="$1"
    local prompt_present=0 status_hint=0 matched=""
    if printf '%s' "$content" | grep -qE '(^|\n)[[:space:]]*❯[[:space:]]*($|\n)'; then
        prompt_present=1; matched="prompt-caret"
    fi
    if [ "$prompt_present" = "0" ] && printf '%s' "$content" | grep -qE '│[[:space:]]*>'; then
        prompt_present=1; matched="prompt-bar"
    fi
    if printf '%s' "$content" | grep -qE 'ctrl\+t to show|shift\+.{1,4} to expand|permissions o|accept edits'; then
        status_hint=1
        [ -n "$matched" ] && matched="$matched+status" || matched="status"
    fi
    if [ "$prompt_present" = "1" ] || [ "$status_hint" = "1" ]; then
        printf '%s' "${matched:-signal}"
        return 0
    fi
    return 1
}
