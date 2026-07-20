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
# bound to a per-mate loopback WebSocket; the TUI and Channel daemon are clients. The
# registrar retries while the pane is alive so a later Channel start/restart is
# healed without letting Channel read workshop.yaml or spawn runtime processes.
SOCKET_DIR="$KA_STATE_DIR/codex-app-servers"
mkdir -p "$SOCKET_DIR"
chmod 700 "$SOCKET_DIR" 2>/dev/null || true
# Registration follows Workshop's channel mapping. In particular, the entry
# marked main:true may have any pane name but must always register as "main".
RUNTIME_NAME="${KA_CHANNEL:-$PANE_NAME}"
SAFE_NAME="$(printf '%s' "$RUNTIME_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')"
[ -n "$SAFE_NAME" ] || SAFE_NAME="main"
SERVER_LOG="$SOCKET_DIR/$SAFE_NAME.log"
PORT_LOCK_DIR="$SOCKET_DIR/.port-allocation.lock"
PORT_LOCK_HELD=0
APP_SERVER_PID=""

release_port_lock() {
    if [ "$PORT_LOCK_HELD" = "1" ]; then
        rm -f "$PORT_LOCK_DIR/pid"
        rmdir "$PORT_LOCK_DIR" 2>/dev/null || true
        PORT_LOCK_HELD=0
    fi
}

cleanup() {
    release_port_lock
    [ -n "${REGISTRAR_PID:-}" ] && kill "$REGISTRAR_PID" 2>/dev/null || true
    curl -sf -X DELETE "http://127.0.0.1:${KA_CHANNEL_PORT:-9877}/api/runtimes/codex/$SAFE_NAME" >/dev/null 2>&1 || true
    [ -n "$APP_SERVER_PID" ] && kill "$APP_SERVER_PID" 2>/dev/null || true
    [ -n "$APP_SERVER_PID" ] && wait "$APP_SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

# Port discovery closes its temporary listener before App Server binds. Serialize
# that small gap across Workshop panes so simultaneous Codex mates cannot select
# the same ephemeral port.
for _ in $(seq 1 200); do
    if mkdir "$PORT_LOCK_DIR" 2>/dev/null; then
        printf '%s\n' "$$" > "$PORT_LOCK_DIR/pid"
        PORT_LOCK_HELD=1
        break
    fi
    lock_pid="$(cat "$PORT_LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f "$PORT_LOCK_DIR/pid"
        rmdir "$PORT_LOCK_DIR" 2>/dev/null || true
    fi
    sleep 0.05
done
[ "$PORT_LOCK_HELD" = "1" ] || { echo "[start-pane:$PANE_NAME] ERROR: timed out allocating App Server port"; exit 1; }

APP_SERVER_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
APP_SERVER_ENDPOINT="ws://127.0.0.1:$APP_SERVER_PORT"

# The legacy Telegram MCP may use the same bot identity as Channel and race its
# getUpdates consumer. Replace that one transport with a disabled valid stdio
# entry for this invocation only; the user's Codex configuration is untouched.
codex \
    -c 'mcp_servers.telegram.command="/usr/bin/true"' \
    -c 'mcp_servers.telegram.args=[]' \
    -c 'mcp_servers.telegram.enabled=false' \
    app-server --listen "$APP_SERVER_ENDPOINT" >>"$SERVER_LOG" 2>&1 &
APP_SERVER_PID=$!

for _ in $(seq 1 100); do
    node -e 'const net=require("net");const s=net.connect(Number(process.argv[1]),"127.0.0.1",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))' "$APP_SERVER_PORT" >/dev/null 2>&1 && break
    kill -0 "$APP_SERVER_PID" 2>/dev/null || {
        echo "[start-pane:$PANE_NAME] ERROR: Codex App Server exited; see $SERVER_LOG"
        exit 1
    }
    sleep 0.1
done
kill -0 "$APP_SERVER_PID" 2>/dev/null || { echo "[start-pane:$PANE_NAME] ERROR: App Server did not start"; exit 1; }
release_port_lock

register_loop() {
    local port="${KA_CHANNEL_PORT:-9877}"
    local status body
    body="$(PANE_NAME="$SAFE_NAME" PANE_CWD="$EXPECTED_CWD" APP_SERVER_ENDPOINT="$APP_SERVER_ENDPOINT" node -e \
        'process.stdout.write(JSON.stringify({name:process.env.PANE_NAME,cwd:process.env.PANE_CWD,endpoint:process.env.APP_SERVER_ENDPOINT}))')"
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
    codex --remote "$APP_SERVER_ENDPOINT" "$@"
}

run_resume_last() {
    started_at="$(date +%s)"
    set +e
    run_codex "$@" resume --last
    rc=$?
    set -e
    elapsed=$(( $(date +%s) - started_at ))
    if [ "$rc" -ne 0 ] && [ "$elapsed" -lt 10 ]; then
        echo "[start-pane:$PANE_NAME] no resumable Codex session; starting fresh"
        run_codex "$@"
        return $?
    fi
    return "$rc"
}

# Explicit arguments are authoritative. This supports session IDs via
# `args: [resume, <session-id>]` and any documented global flags.
if [ "$#" -gt 0 ]; then
    # Claude Code used a top-level `--last`; Codex exposes it under `resume`.
    # Preserve the remaining global flags when an existing Workshop config is
    # migrated by changing only its runtime.
    if [ "$1" = "--last" ]; then
        shift
        echo "[start-pane:$PANE_NAME] codex $* resume --last (Workshop-managed App Server)"
        run_resume_last "$@"
    else
        echo "[start-pane:$PANE_NAME] codex $* (Workshop-managed App Server)"
        run_codex "$@"
    fi
    exit $?
fi

# `resume --last` is global and can attach several concurrently-started mates to
# the same thread. Start an isolated TUI by default; callers that need continuity
# must provide `args: [resume, <thread-id>]` explicitly.
run_codex --sandbox workspace-write --ask-for-approval on-request
exit $?
