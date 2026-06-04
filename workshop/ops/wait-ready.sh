#!/bin/bash
# ka wait-ready — poll a tmux pane until its CC runtime is ready to accept
# injected prompts (resume + hooks + MCP init settled, prompt box idle).
#
# Intended callers:
#   * ka start --spawn-mates (before dispatching mate spawn prompt)
#   * ka spawn-mates         (sanity check pre-injection)
#   * humans after ka start, when scripting follow-up prompts
#
# Detection heuristic — pane is considered ready when BOTH:
#   1. tmux capture-pane content contains a recognizable CC input-prompt marker.
#      Two shapes seen in the wild (CC TUI has changed its frame glyphs):
#        * `│ >`  — older bordered prompt (still used by unit-test fixtures)
#        * `❯`    — current prompt glyph, rendered on its own line between
#                   horizontal rules
#      Additionally, a status-line hint fragment (`ctrl+t`, `shift+` expand
#      hint, or `permissions o`/`accept edits`) is a strong "fully booted"
#      signal — CC only renders the bottom hint strip when past init.
#   2. Those signals remain present for STABLE_SEC seconds of consecutive
#      polls. We do NOT require the whole pane to be byte-identical — a live
#      CC pane has an animating spinner and a rotating status strip even
#      while idle, so cksum-based stability produces false negatives against
#      a real ready pane. Signal-presence stability is enough.
#
# Exit codes:
#   0  pane is ready
#   1  timeout waiting for ready state
#   3  config/session/pane not found (hard misconfig, not just "not ready yet")
#
# Flags:
#   --session NAME      override session from workshop.yaml
#   --target  PANE      target tmux pane (default: <session>:0.0 = main)
#   --timeout SEC       seconds before giving up (default: 60)
#   --stable  SEC       idle-stability window (default: 2)
#   --verbose | -v      log each poll iteration
set -euo pipefail

KA_REPO_ROOT="${KA_REPO_ROOT:-$(_d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; until [ -e "$_d/.ka-root" ] || [ "$_d" = / ]; do _d="$(dirname "$_d")"; done; printf %s "$_d")}"
source "$KA_REPO_ROOT/shared/ops/common.sh"
# shellcheck source=../lib/tmux-helpers.sh
source "$KA_LIB_DIR/tmux-helpers.sh"
# shellcheck source=../lib/runtimes/dispatch.sh
source "$KA_RUNTIMES_DIR/dispatch.sh"

SESSION=""
TARGET_OVERRIDE=""
TIMEOUT=60
STABLE_SEC=2
VERBOSE=0
prev_arg=""
for arg in "$@"; do
    case "$arg" in
        --timeout=*) TIMEOUT="${arg#--timeout=}" ;;
        --timeout)   : ;;
        --session=*) SESSION="${arg#--session=}" ;;
        --session)   : ;;
        --target=*)  TARGET_OVERRIDE="${arg#--target=}" ;;
        --target)    : ;;
        --stable=*)  STABLE_SEC="${arg#--stable=}" ;;
        --stable)    : ;;
        --verbose|-v) VERBOSE=1 ;;
        *)
            case "$prev_arg" in
                --timeout) TIMEOUT="$arg" ;;
                --session) SESSION="$arg" ;;
                --target)  TARGET_OVERRIDE="$arg" ;;
                --stable)  STABLE_SEC="$arg" ;;
            esac
            ;;
    esac
    prev_arg="$arg"
done

CONFIG="$(resolve_workshop_config)"
if [ -z "$SESSION" ]; then
    if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
        log_err "no workshop config found (set OPS_CONFIG or pass --session NAME)"
        exit 3
    fi
    SESSION="$(workshop_session_name "$CONFIG")"
fi

RUNTIME="$(runtime_default_from_config "$CONFIG")"
if ! runtime_load "$RUNTIME"; then
    log_err "runtime '$RUNTIME' not supported (phase-2: only cc)"
    exit 3
fi

tmux_require

if ! tmux_has_session "$SESSION"; then
    log_err "session '$SESSION' not running"
    exit 3
fi

TARGET="${TARGET_OVERRIDE:-$SESSION:0.0}"
if ! "$TMUX_BIN" display-message -p -t "$TARGET" "#{pane_id}" >/dev/null 2>&1; then
    log_err "pane $TARGET not found in session $SESSION"
    exit 3
fi

capture() {
    "$TMUX_BIN" capture-pane -t "$TARGET" -p -J 2>/dev/null || true
}

log_info "waiting for $TARGET to be ready (timeout=${TIMEOUT}s, stable=${STABLE_SEC}s)"

start_ts=$(date +%s)
prev_sig=""
stable_since=0

while :; do
    now=$(date +%s)
    elapsed=$(( now - start_ts ))
    if [ "$elapsed" -ge "$TIMEOUT" ]; then
        log_err "timeout after ${TIMEOUT}s — $TARGET never reached ready state"
        exit 1
    fi

    content="$(capture)"
    sig="$(printf '%s' "$content" | cksum | awk '{print $1 "-" $2}')"

    # Delegate signal detection to the runtime adapter (phase 2). The adapter
    # echoes a tag on match (e.g. "prompt-caret", "status", "prompt-caret+status")
    # and exits 1 when no signal is found.
    matched=""
    ready_sig=0
    if matched="$(runtime::ready_match "$content")"; then
        ready_sig=1
    fi

    if [ "$VERBOSE" = "1" ]; then
        log_dim "elapsed=${elapsed}s sig=${sig} ready=${ready_sig} matched=${matched:-none}"
    fi

    if [ "$ready_sig" = "1" ]; then
        if [ "$stable_since" -eq 0 ]; then
            stable_since=$now
        elif [ $(( now - stable_since )) -ge "$STABLE_SEC" ]; then
            log_ok "$TARGET ready (${matched:-signal}, stable ${STABLE_SEC}s)"
            exit 0
        fi
    else
        stable_since=0
    fi
    prev_sig="$sig"
    sleep 0.5
done
