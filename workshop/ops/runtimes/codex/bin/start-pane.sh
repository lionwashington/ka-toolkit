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
THREAD_SELECTOR_PID=""
THREAD_SELECTOR_OUTPUT=""
TUI_PID=""

release_port_lock() {
    if [ "$PORT_LOCK_HELD" = "1" ]; then
        rm -f "$PORT_LOCK_DIR/pid"
        rmdir "$PORT_LOCK_DIR" 2>/dev/null || true
        PORT_LOCK_HELD=0
    fi
}

cleanup() {
    release_port_lock
    [ -n "$THREAD_SELECTOR_PID" ] && kill "$THREAD_SELECTOR_PID" 2>/dev/null || true
    [ -n "$THREAD_SELECTOR_PID" ] && wait "$THREAD_SELECTOR_PID" 2>/dev/null || true
    [ -n "$THREAD_SELECTOR_OUTPUT" ] && rm -f "$THREAD_SELECTOR_OUTPUT"
    [ -n "$TUI_PID" ] && kill "$TUI_PID" 2>/dev/null || true
    [ -n "$TUI_PID" ] && wait "$TUI_PID" 2>/dev/null || true
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
# entry for both App Server and remote TUI invocations; the user's Codex
# configuration is untouched. The TUI also loads MCP configuration during its
# own bootstrap even though it connects to an external App Server.
TELEGRAM_MCP_OVERRIDES=(
    -c 'mcp_servers.telegram.command="/usr/bin/true"'
    -c 'mcp_servers.telegram.args=[]'
    -c 'mcp_servers.telegram.enabled=false'
)
# The sidecar must never inherit the pane's stdin. This shell runs without job
# control, so a background App Server otherwise shares the foreground process
# group with the TUI and can consume terminal replies or keystrokes.
codex "${TELEGRAM_MCP_OVERRIDES[@]}" \
    --dangerously-bypass-hook-trust \
    --dangerously-bypass-approvals-and-sandbox \
    app-server --listen "$APP_SERVER_ENDPOINT" </dev/null >>"$SERVER_LOG" 2>&1 &
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

REQUESTED_THREAD_ID=""
declare -a TUI_ARGS
TUI_ARGS=("$@")
# Older Workshop configs commonly stored `resume --last` or `resume <id>` as
# one YAML list item. Treat those exact forms as resume directives instead of
# passing them as a prompt-shaped argv to Codex.
if [ "${1:-}" = "resume --last" ] || [ "${1:-}" = "resume latest" ]; then
    shift
    TUI_ARGS=("$@")
elif [[ "${1:-}" =~ ^resume[[:space:]]+([0-9a-fA-F-]+)[[:space:]]*$ ]]; then
    REQUESTED_THREAD_ID="${BASH_REMATCH[1]}"
    shift
    TUI_ARGS=("$@")
fi
if [ "${1:-}" = "--last" ]; then
    shift
    TUI_ARGS=("$@")
elif [ "${1:-}" = "resume" ] && { [ "${2:-}" = "--last" ] || [ "${2:-}" = "latest" ]; }; then
    shift 2
    TUI_ARGS=("$@")
elif [ "${1:-}" = "resume" ] && [ -n "${2:-}" ]; then
    REQUESTED_THREAD_ID="$2"
    shift 2
    TUI_ARGS=("$@")
fi

run_codex() {
    codex "${TELEGRAM_MCP_OVERRIDES[@]}" --remote "$APP_SERVER_ENDPOINT" "$@"
}

# Workshop panes are unattended runtime processes. Make approval bypass the
# default even when a mate also configures unrelated arguments such as --model.
# Preserve an explicitly supplied copy without duplicating it.
HAS_BYPASS=0
HAS_HOOK_TRUST_BYPASS=0
if [ "${#TUI_ARGS[@]}" -gt 0 ]; then
    for arg in "${TUI_ARGS[@]}"; do
        [ "$arg" = "--dangerously-bypass-approvals-and-sandbox" ] && HAS_BYPASS=1
        [ "$arg" = "--dangerously-bypass-hook-trust" ] && HAS_HOOK_TRUST_BYPASS=1
    done
fi
if [ "$HAS_BYPASS" -eq 0 ]; then
    if [ "${#TUI_ARGS[@]}" -eq 0 ]; then
        TUI_ARGS=(--dangerously-bypass-approvals-and-sandbox)
    else
        TUI_ARGS=(--dangerously-bypass-approvals-and-sandbox "${TUI_ARGS[@]}")
    fi
fi
if [ "$HAS_HOOK_TRUST_BYPASS" -eq 0 ]; then
    TUI_ARGS=(--dangerously-bypass-hook-trust "${TUI_ARGS[@]}")
fi

THREAD_SELECTOR="${KA_CODEX_THREAD_SELECTOR:-$KA_RUNTIMES_DIR/codex/select-thread.mjs}"
THREAD_OWNER_FILE="$SOCKET_DIR/$SAFE_NAME.thread"
THREAD_JSON="$(node "$THREAD_SELECTOR" "$APP_SERVER_ENDPOINT" "$EXPECTED_CWD" "$REQUESTED_THREAD_ID" select)" || {
    echo "[start-pane:$PANE_NAME] ERROR: cannot select canonical Codex thread"
    exit 1
}
FRESH_THREAD="$(printf '%s' "$THREAD_JSON" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).fresh?"1":"0"))')"

if [ "$FRESH_THREAD" = "1" ]; then
    echo "[start-pane:$PANE_NAME] no existing Codex session; starting a new TUI thread"
    THREAD_SELECTOR_OUTPUT="$SOCKET_DIR/.$SAFE_NAME.thread-select.$$"
    node "$THREAD_SELECTOR" "$APP_SERVER_ENDPOINT" "$EXPECTED_CWD" "" wait > "$THREAD_SELECTOR_OUTPUT" &
    THREAD_SELECTOR_PID=$!
    CODEX_TUI_STDIN="${KA_CODEX_TUI_STDIN:-/dev/tty}"
    run_codex "${TUI_ARGS[@]}" <"$CODEX_TUI_STDIN" &
    TUI_PID=$!
    for _ in $(seq 1 300); do
        [ -s "$THREAD_SELECTOR_OUTPUT" ] && break
        kill -0 "$THREAD_SELECTOR_PID" 2>/dev/null || break
        kill -0 "$TUI_PID" 2>/dev/null || break
        sleep 0.05
    done
    if [ ! -s "$THREAD_SELECTOR_OUTPUT" ]; then
        wait "$THREAD_SELECTOR_PID" 2>/dev/null || true
        THREAD_SELECTOR_PID=""
        echo "[start-pane:$PANE_NAME] ERROR: TUI did not create a canonical Codex thread"
        exit 1
    fi
    THREAD_JSON="$(cat "$THREAD_SELECTOR_OUTPUT")"
    wait "$THREAD_SELECTOR_PID" 2>/dev/null || true
    THREAD_SELECTOR_PID=""
    rm -f "$THREAD_SELECTOR_OUTPUT"
    THREAD_SELECTOR_OUTPUT=""
fi

CANONICAL_THREAD_ID="$(printf '%s' "$THREAD_JSON" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).id))')"
CANONICAL_THREAD_PATH="$(printf '%s' "$THREAD_JSON" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).path||""))')"
[ -n "$CANONICAL_THREAD_ID" ] || { echo "[start-pane:$PANE_NAME] ERROR: canonical thread id is empty"; exit 1; }
if [ -z "$REQUESTED_THREAD_ID" ]; then
    THREAD_OWNER_TMP="$THREAD_OWNER_FILE.$$"
    printf '%s\n' "$CANONICAL_THREAD_ID" > "$THREAD_OWNER_TMP"
    chmod 600 "$THREAD_OWNER_TMP" 2>/dev/null || true
    mv "$THREAD_OWNER_TMP" "$THREAD_OWNER_FILE"
fi

register_loop() {
    local port="${KA_CHANNEL_PORT:-9877}"
    local status body persisted_json resolved_path
    local thread_path="$CANONICAL_THREAD_PATH"
    local allow_unpersisted="$FRESH_THREAD"
    local last_registered_allow=""
    while kill -0 "$APP_SERVER_PID" 2>/dev/null; do
        # A fresh thread is visible to thread/list before its rollout can be
        # resumed. Keep the initial allow_unpersisted registration, then detect
        # the first successful resume and promote Channel to a subscribed
        # registration. Without this transition Channel can poll the final turn
        # but receives no turn/started or agent-message delta notifications.
        if [ "$allow_unpersisted" = "1" ]; then
            persisted_json="$(node "$THREAD_SELECTOR" "$APP_SERVER_ENDPOINT" "$EXPECTED_CWD" "$CANONICAL_THREAD_ID" select 2>/dev/null || true)"
            resolved_path="$(printf '%s' "$persisted_json" | THREAD_ID="$CANONICAL_THREAD_ID" node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);if(j.id===process.env.THREAD_ID)process.stdout.write(j.path||"resumable")}catch{}})' 2>/dev/null || true)"
            if [ -n "$resolved_path" ]; then
                [ "$resolved_path" = "resumable" ] || thread_path="$resolved_path"
                allow_unpersisted=0
            fi
        fi
        body="$(PANE_NAME="$SAFE_NAME" PANE_CWD="$EXPECTED_CWD" APP_SERVER_ENDPOINT="$APP_SERVER_ENDPOINT" THREAD_ID="$CANONICAL_THREAD_ID" THREAD_PATH="$thread_path" ALLOW_UNPERSISTED_THREAD="$allow_unpersisted" node -e \
            'process.stdout.write(JSON.stringify({name:process.env.PANE_NAME,cwd:process.env.PANE_CWD,endpoint:process.env.APP_SERVER_ENDPOINT,thread_id:process.env.THREAD_ID,thread_path:process.env.THREAD_PATH||undefined,allow_unpersisted_thread:process.env.ALLOW_UNPERSISTED_THREAD==="1"}))')"
        status="$(curl -sf --max-time 1 "http://127.0.0.1:$port/api/status" 2>/dev/null || true)"
        if [ "$last_registered_allow" != "$allow_unpersisted" ] || ! printf '%s' "$status" | PANE_NAME="$SAFE_NAME" node -e \
            'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.runtime_targets?.some(x=>x.name===process.env.PANE_NAME)?0:1)}catch{process.exit(1)}})' \
            2>/dev/null; then
            if curl -sf --max-time 5 -H 'content-type: application/json' -d "$body" \
                "http://127.0.0.1:$port/api/runtimes/codex" >/dev/null 2>&1; then
                last_registered_allow="$allow_unpersisted"
            fi
        fi
        sleep 5
    done
}
register_loop &
REGISTRAR_PID=$!

set +e
if [ "$FRESH_THREAD" = "1" ]; then
    printf '[start-pane:%s] codex %s (new thread %s; Workshop-managed App Server)\n' \
        "$PANE_NAME" "${TUI_ARGS[*]}" "$CANONICAL_THREAD_ID" >> "$SERVER_LOG"
    wait "$TUI_PID"
    TUI_STATUS=$?
    TUI_PID=""
else
    echo "[start-pane:$PANE_NAME] codex ${TUI_ARGS[*]} resume $CANONICAL_THREAD_ID (Workshop-managed App Server)"
    run_codex "${TUI_ARGS[@]}" resume "$CANONICAL_THREAD_ID"
    TUI_STATUS=$?
fi
set -e
printf '[start-pane:%s] Codex TUI exited with status %s\n' "$PANE_NAME" "$TUI_STATUS" | tee -a "$SERVER_LOG" >&2
# A Channel-owned turn runs in the App Server, not in the TUI. Keep the
# sidecar alive if the TUI exits so a long Telegram/Lark turn is not killed
# mid-flight. The wrapper remains the pane owner and performs normal cleanup
# when the fallback shell exits or Workshop stops the pane.
if [ "${KA_CODEX_KEEP_APP_SERVER_ON_TUI_EXIT:-1}" = "1" ] && kill -0 "$APP_SERVER_PID" 2>/dev/null; then
    echo "[start-pane:$PANE_NAME] App Server remains available; TUI exited, opening a shell" >&2
    "${SHELL:-/bin/zsh}" -l
fi
exit "$TUI_STATUS"
