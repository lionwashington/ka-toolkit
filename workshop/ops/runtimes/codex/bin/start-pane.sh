#!/bin/bash
set -euo pipefail

PANE_NAME="${1:?pane name required}"
EXPECTED_CWD="${2:?expected cwd required}"
shift 2

: "${KA_HOME:=$HOME/.knowledge-assistant}"
source "$KA_HOME/shared/ops/common.sh"

if [ "$PWD" != "$EXPECTED_CWD" ]; then
    cd "$EXPECTED_CWD" || {
        echo "[start-pane:$PANE_NAME] FATAL: cannot cd to $EXPECTED_CWD"
        exec "${SHELL:-/bin/zsh}" -l
    }
fi

ENV_FILE="$KA_PANES_DIR/$PANE_NAME.env"
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
fi

for _ in $(seq 1 20); do
    if command -v codex >/dev/null 2>&1; then break; fi
    sleep 0.5
done
if ! command -v codex >/dev/null 2>&1; then
    echo "[start-pane:$PANE_NAME] ERROR: codex not on PATH; dropping to shell"
    exec "${SHELL:-/bin/zsh}" -l
fi

# Explicit arguments are authoritative. This supports session IDs via
# `args: [resume, <session-id>]` and any documented global flags.
if [ "$#" -gt 0 ]; then
    echo "[start-pane:$PANE_NAME] exec codex $*"
    exec codex "$@"
fi

# Default to the most recent interactive session for this cwd. On a first-ever
# launch `resume --last` exits quickly because no session exists; only that
# startup failure falls back to a fresh TUI. A normally used TUI is never
# relaunched after the user exits.
started_at="$(date +%s)"
set +e
codex resume --last --sandbox workspace-write --ask-for-approval on-request
rc=$?
set -e
elapsed=$(( $(date +%s) - started_at ))
if [ "$rc" -ne 0 ] && [ "$elapsed" -lt 10 ]; then
    echo "[start-pane:$PANE_NAME] no resumable Codex session; starting fresh"
    exec codex --sandbox workspace-write --ask-for-approval on-request
fi
exit "$rc"
