#!/bin/bash
# ops/lib/runtimes/dispatch.sh — source the adapter files for a runtime.
#
# Usage (from a `ka` CLI subcommand):
#
#     source "$OPS_DIR/lib/runtimes/dispatch.sh"
#     runtime_load "cc"                 # sources ops/lib/runtimes/cc/*.sh
#     runtime::ready_match "$content"   # call any adapter function
#
# Adapters live at `ops/lib/runtimes/<name>/*.sh` and define shell functions
# named `runtime::<verb>` (see ops/lib/runtimes/interface.md). Only one runtime
# is active per CLI invocation — we use a flat `runtime::` namespace instead of
# an associative dispatch table to stay bash 3.2 compatible.
#
# Phase 2: `cc` is the only fully-implemented adapter. `codex` / `gemini`
# remain reserved names — calling runtime_load with them exits non-zero.

if [ -z "${KA_RUNTIMES_DIR:-}" ]; then
    KA_RUNTIMES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

# Resolve the default runtime from a parsed-config stream (output of
# yaml-parse.sh). Falls back to "cc" when no record is present (backwards-
# compatible with pre-phase-1 configs).
runtime_default_from_config() {
    local cfg="$1"
    local rt="cc"
    if [ -n "$cfg" ] && [ -f "$cfg" ]; then
        local rec kind a
        while IFS= read -r rec; do
            [ -z "$rec" ] && continue
            IFS=$'\t' read -r kind a _ <<<"$rec"
            if [ "$kind" = "runtime_default" ]; then
                rt="$a"
                break
            fi
        done < <("$KA_RUNTIMES_DIR/../yaml-parse.sh" "$cfg" 2>/dev/null)
    fi
    printf '%s' "$rt"
}

# Source every *.sh adapter file for the given runtime. Does not fail if the
# adapter dir is missing specific topic files — the interface only mandates the
# function names, not the filename layout.
runtime_load() {
    local rt="$1"
    [ -z "$rt" ] && rt="cc"
    local dir="$KA_RUNTIMES_DIR/$rt"
    if [ ! -d "$dir" ]; then
        echo "runtime_load: unknown runtime '$rt' (dir $dir not found)" >&2
        return 1
    fi
    # Phase 2 only implements cc. Codex/Gemini dirs may exist as placeholders
    # later — fail loudly if they're requested before adapters land.
    case "$rt" in
        cc) ;;
        codex|gemini)
            echo "runtime_load: '$rt' adapter not yet implemented (phase 3+); see docs/KA_CLI_RUNTIME_DESIGN.md" >&2
            return 1
            ;;
    esac
    local f
    for f in "$dir"/*.sh; do
        [ -f "$f" ] || continue
        # shellcheck disable=SC1090
        source "$f"
    done
    return 0
}

# Convenience: does the currently-loaded runtime support a concept? Adapters
# that don't implement an optional function either leave it undefined or
# define it as a stub printing "n/a". Callers can use this before branching.
runtime_has() {
    local fn="$1"
    # `declare -F` is locale-independent; `type | grep 'is a function'` would
    # break under non-English LANG settings.
    declare -F "$fn" >/dev/null 2>&1
}
