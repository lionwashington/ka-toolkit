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

# Workshop owns both processes for a Codex mate. The App Server is a sidecar
# bound to a per-mate Unix socket; the TUI and Channel daemon are clients. The
# registrar retries while the pane is alive so a later Channel start/restart is
# healed without letting Channel read workshop.yaml or spawn runtime processes.
SOCKET_DIR="$KA_STATE_DIR/codex-app-servers"
mkdir -p "$SOCKET_DIR"
chmod 700 "$SOCKET_DIR" 2>/dev/null || true
SAFE_NAME="$(printf '%s' "$PANE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')"
[ -n "$SAFE_NAME" ] || SAFE_NAME="main"
SOCKET_PATH="$SOCKET_DIR/$SAFE_NAME.sock"
SERVER_LOG="$SOCKET_DIR/$SAFE_NAME.log"
rm -f "$SOCKET_PATH"

codex app-server --listen "unix://$SOCKET_PATH" >>"$SERVER_LOG" 2>&1 &
APP_SERVER_PID=$!

cleanup() {
    [ -n "${REGISTRAR_PID:-}" ] && kill "$REGISTRAR_PID" 2>/dev/null || true
    curl -sf -X DELETE "http://127.0.0.1:${KA_CHANNEL_PORT:-9877}/api/runtimes/codex/$SAFE_NAME" >/dev/null 2>&1 || true
    kill "$APP_SERVER_PID" 2>/dev/null || true
    wait "$APP_SERVER_PID" 2>/dev/null || true
    rm -f "$SOCKET_PATH"
}
trap cleanup EXIT INT TERM HUP

for _ in $(seq 1 100); do
    [ -S "$SOCKET_PATH" ] && break
    kill -0 "$APP_SERVER_PID" 2>/dev/null || {
        echo "[start-pane:$PANE_NAME] ERROR: Codex App Server exited; see $SERVER_LOG"
        exit 1
    }
    sleep 0.1
done
[ -S "$SOCKET_PATH" ] || { echo "[start-pane:$PANE_NAME] ERROR: App Server socket was not created"; exit 1; }

register_loop() {
    local port="${KA_CHANNEL_PORT:-9877}"
    local status body
    body="$(PANE_NAME="$SAFE_NAME" PANE_CWD="$EXPECTED_CWD" SOCKET_PATH="$SOCKET_PATH" node -e \
        'process.stdout.write(JSON.stringify({name:process.env.PANE_NAME,cwd:process.env.PANE_CWD,socket_path:process.env.SOCKET_PATH}))')"
    while kill -0 "$APP_SERVER_PID" 2>/dev/null; do
        status="$(curl -sf --max-time 1 "http://127.0.0.1:$port/api/status" 2>/dev/null || true)"
        if ! printf '%s' "$status" | PANE_NAME="$SAFE_NAME" node -e \
            'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.runtime_targets?.some(x=>x.name===process.env.PANE_NAME)?0:1)}catch{process.exit(1)}})' \
            2>/dev/null; then
            curl -sf --max-time 5 -H 'content-type: application/json' -d "$body" \
                "http://127.0.0.1:$port/api/runtimes/codex" >/dev/null 2>&1 || true
        fi
        sleep 5
    done
}
register_loop &
REGISTRAR_PID=$!

run_codex() {
    codex --remote "unix://$SOCKET_PATH" "$@"
}

# Explicit arguments are authoritative. This supports session IDs via
# `args: [resume, <session-id>]` and any documented global flags.
if [ "$#" -gt 0 ]; then
    echo "[start-pane:$PANE_NAME] codex $* (Workshop-managed App Server)"
    run_codex "$@"
    exit $?
fi

# Default to the most recent interactive session for this cwd. On a first-ever
# launch `resume --last` exits quickly because no session exists; only that
# startup failure falls back to a fresh TUI. A normally used TUI is never
# relaunched after the user exits.
started_at="$(date +%s)"
set +e
run_codex resume --last --sandbox workspace-write --ask-for-approval on-request
rc=$?
set -e
elapsed=$(( $(date +%s) - started_at ))
if [ "$rc" -ne 0 ] && [ "$elapsed" -lt 10 ]; then
    echo "[start-pane:$PANE_NAME] no resumable Codex session; starting fresh"
    run_codex --sandbox workspace-write --ask-for-approval on-request
    exit $?
fi
exit "$rc"
