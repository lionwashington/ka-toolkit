#!/bin/bash
# start-pane.sh — first process inside a freshly created tmux pane.
#
# Responsibilities (the middle layer of the 3-layer cwd guarantee):
#   1. Verify PWD matches the expected cwd passed by bootstrap.sh
#      (tmux `-c` already set it; we double-check.)
#   2. Load pane-specific env from ops/panes/<name>.env if present.
#   3. Wait briefly for `claude` to be on PATH (slow shell init / nvm / asdf).
#   4. exec claude with forwarded args.
#
# Usage: start-pane.sh <pane-name> <expected-cwd> [extra claude args...]

set -euo pipefail

PANE_NAME="${1:?pane name required}"
EXPECTED_CWD="${2:?expected cwd required}"
shift 2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "[start-pane:$PANE_NAME] pwd=$PWD expected=$EXPECTED_CWD"

if [ "$PWD" != "$EXPECTED_CWD" ]; then
    echo "[start-pane:$PANE_NAME] WARN: cwd mismatch, fixing..."
    cd "$EXPECTED_CWD" || {
        echo "[start-pane:$PANE_NAME] FATAL: cannot cd to $EXPECTED_CWD"
        exec "${SHELL:-/bin/zsh}" -l
    }
fi

ENV_FILE="$OPS_DIR/panes/$PANE_NAME.env"
if [ -f "$ENV_FILE" ]; then
    echo "[start-pane:$PANE_NAME] loading $ENV_FILE"
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
fi

# Wait up to 10s for claude to appear on PATH.
for _ in $(seq 1 20); do
    if command -v claude >/dev/null 2>&1; then break; fi
    sleep 0.5
done

if ! command -v claude >/dev/null 2>&1; then
    echo "[start-pane:$PANE_NAME] ERROR: claude not on PATH; dropping to shell"
    exec "${SHELL:-/bin/zsh}" -l
fi

# Channel mode (`ka workshop`): when KA_CHANNEL is set, bind this pane to a
# telegram-channel daemon channel instead of the old telegram plugin.
#   - The `--dangerously-load-development-channels server:telegram-channel`
#     CONSUMER resolves its channel from a PERSISTENTLY REGISTERED MCP server
#     (a temp --mcp-config is NOT enough). So we register `telegram-channel` in
#     THIS pane's cwd project-local scope, pointing at ?name=$KA_CHANNEL. Because
#     each pane has its own cwd, these registrations are naturally isolated —
#     no cross-pane race over a shared registration.
#   - Then prepend the dev-channels flag (+ --dangerously-skip-permissions so the
#     CC can auto-reply), deduping skip-permissions if the caller already passed it.
if [ -n "${KA_CHANNEL:-}" ]; then
    # Channel KIND picks which daemon this pane binds to: telegram-channel@9877 or
    # lark-channel@9876. KA_CHANNEL_KIND defaults to telegram (back-compat).
    _chan_kind="${KA_CHANNEL_KIND:-telegram}"
    _chan_server="${_chan_kind}-channel"      # telegram-channel | lark-channel
    if [ "$_chan_kind" = "lark" ]; then _def_port=9876; else _def_port=9877; fi
    _chan_port="${KA_CHANNEL_PORT:-$_def_port}"
    _chan_url="http://127.0.0.1:${_chan_port}/mcp?name=${KA_CHANNEL}"
    claude mcp remove "$_chan_server" >/dev/null 2>&1 || true
    if claude mcp add --transport http --scope local "$_chan_server" "$_chan_url" >/dev/null 2>&1; then
        echo "[start-pane:$PANE_NAME] channel: registered $_chan_server → $_chan_url"
    else
        echo "[start-pane:$PANE_NAME] channel: WARN failed to register $_chan_server → $_chan_url"
    fi
    _has_skip=0
    for _a in "$@"; do [ "$_a" = "--dangerously-skip-permissions" ] && _has_skip=1; done
    if [ "$_has_skip" -eq 1 ]; then
        set -- --dangerously-load-development-channels "server:$_chan_server" "$@"
    else
        set -- --dangerously-skip-permissions --dangerously-load-development-channels "server:$_chan_server" "$@"
    fi
    echo "[start-pane:$PANE_NAME] channel: kind=$_chan_kind name=$KA_CHANNEL flags prepended"
fi

# Dynamically resolve `--resume <sid>`: if the configured session id no longer
# exists for this cwd's Claude project dir, substitute the most recent session;
# if none exists, drop `--resume` entirely and start fresh. This prevents
# start-up failures when the lead's cwd changes or old sessions are purged.
#
# Special sentinels:
#   --resume latest  : newest jsonl by mtime in proj_dir (pollution-prone for
#                      lead pane on CC 2.1.126 — prefer `pinned` for lead;
#                      see memory/topics/tools.md "CC 2.1.126 cwd inheritance bug").
#   --resume pinned  : sid from $KA_STATE_DIR/lead-session.id (default
#                      $HOME/.knowledge-assistant/state/lead-session.id);
#                      fallback to fresh start if pin missing or jsonl gone.
#                      ops/cli/start.sh writes the pin via capture-lead-sid.sh
#                      after lead is ready, before any mate spawns.
resolve_resume_args() {
    # claude encodes proj_dir by turning both / and . into - (e.g.
    # ~/temp/myproj/books.ext → -Users-me-temp-myproj-books-ext). Converting only
    # / would compute the wrong dir when cwd contains a dot → fail to find the
    # session history → wrongly start fresh. So convert / and . together to match claude.
    local proj_dir="$HOME/.claude/projects/$(printf '%s' "$PWD" | tr '/.' '-')"
    local -a out=()
    local i=0
    local n=$#
    local args=("$@")
    while [ "$i" -lt "$n" ]; do
        local a="${args[$i]}"
        if [ "$a" = "--resume" ] && [ $((i + 1)) -lt "$n" ]; then
            local sid="${args[$((i + 1))]}"
            # "latest" sentinel: always resolve to the most recent session
            if [ "$sid" = "latest" ]; then
                local latest=""
                if [ -d "$proj_dir" ]; then
                    # `|| true`: under `set -e`+pipefail, a non-matching glob
                    # makes `ls` exit non-zero → propagated by pipefail → kills
                    # the script before exec. Swallow it so an empty proj_dir
                    # just yields latest="" (fresh start) instead of rc=1.
                    latest="$(ls -t "$proj_dir"/*.jsonl 2>/dev/null | head -1 || true)"
                fi
                if [ -n "$latest" ]; then
                    local new_sid
                    new_sid="$(basename "$latest" .jsonl)"
                    out+=("--resume" "$new_sid")
                    echo "[start-pane:$PANE_NAME] resume: latest → $new_sid" >&2
                else
                    echo "[start-pane:$PANE_NAME] resume: no sessions in $proj_dir; starting fresh" >&2
                fi
            elif [ "$sid" = "pinned" ]; then
                local pin_file="${KA_STATE_DIR:-$HOME/.knowledge-assistant/state}/lead-session.id"
                local pinned_sid=""
                if [ -f "$pin_file" ]; then
                    pinned_sid="$(tr -d '[:space:]' < "$pin_file" 2>/dev/null || true)"
                fi
                if [ -n "$pinned_sid" ] && [ -f "$proj_dir/$pinned_sid.jsonl" ]; then
                    out+=("--resume" "$pinned_sid")
                    echo "[start-pane:$PANE_NAME] resume: pinned → $pinned_sid" >&2
                elif [ -n "$pinned_sid" ]; then
                    echo "[start-pane:$PANE_NAME] resume: pinned $pinned_sid jsonl gone; starting fresh (capture-lead-sid will repin)" >&2
                else
                    echo "[start-pane:$PANE_NAME] resume: pinned (no pin file at $pin_file); starting fresh (first ever boot or pin lost)" >&2
                fi
            elif [ -f "$proj_dir/$sid.jsonl" ]; then
                out+=("--resume" "$sid")
                echo "[start-pane:$PANE_NAME] resume: $sid (configured, exists)" >&2
            else
                local latest=""
                if [ -d "$proj_dir" ]; then
                    # `|| true`: under `set -e`+pipefail, a non-matching glob
                    # makes `ls` exit non-zero → propagated by pipefail → kills
                    # the script before exec. Swallow it so an empty proj_dir
                    # just yields latest="" (fresh start) instead of rc=1.
                    latest="$(ls -t "$proj_dir"/*.jsonl 2>/dev/null | head -1 || true)"
                fi
                if [ -n "$latest" ]; then
                    local new_sid
                    new_sid="$(basename "$latest" .jsonl)"
                    out+=("--resume" "$new_sid")
                    echo "[start-pane:$PANE_NAME] resume: $sid missing; falling back to latest=$new_sid" >&2
                else
                    echo "[start-pane:$PANE_NAME] resume: $sid missing and no sessions in $proj_dir; starting fresh" >&2
                fi
            fi
            i=$((i + 2))
            continue
        fi
        out+=("$a")
        i=$((i + 1))
    done
    if [ ${#out[@]} -gt 0 ]; then
        RESOLVED_ARGS=("${out[@]}")
    else
        RESOLVED_ARGS=()
    fi
}

RESOLVED_ARGS=()
if [ $# -gt 0 ]; then
    resolve_resume_args "$@"
else
    RESOLVED_ARGS=()
fi

echo "[start-pane:$PANE_NAME] exec claude ${RESOLVED_ARGS[*]}"
exec claude "${RESOLVED_ARGS[@]}"
