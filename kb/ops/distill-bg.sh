#!/bin/bash
# ops/kb/distill-bg.sh — start a background /kb distill through the configured runtime
# Opus process. Returns immediately after spawning the worker; the worker
# writes status to ~/.knowledge-assistant/state/distill-current.json and a
# per-run log to ~/.knowledge-assistant/state/distill-<timestamp>.log.
#
# Usage:
#   ka kb distill --background --jsonl <abs path> [--session-id <uuid>] [--dry-run]
#
# Snapshot enforcement (race condition guard):
#   Captures the jsonl's current byte size + last-entry-uuid before spawning.
#   The worker passes --upper-offset <snapshot> to ka-jsonl-reader so any
#   messages appended to the jsonl after the snapshot are left for the next
#   distill run.
#
# Exit codes:
#   0 — worker spawned successfully (foreground returns; worker continues)
#   1 — argument error
#   2 — file/env error (jsonl missing, can't write state dir, etc.)

set -euo pipefail
: "${KA_HOME:=$HOME/.knowledge-assistant}"
source "$KA_HOME/shared/ops/common.sh"

# Resolve the headless executor from the typed config reader unless explicitly
# overridden for an experiment. Export it so the detached worker inherits it.
if [ -z "${KA_DISTILL_RUNTIME:-}" ]; then
    _config_cli="$KA_HOME/kb/core/dist/config-cli.js"
    if [ -f "$_config_cli" ]; then
        KA_DISTILL_RUNTIME="$(node "$_config_cli" distill-runtime 2>/dev/null || true)"
    fi
fi
export KA_DISTILL_RUNTIME="${KA_DISTILL_RUNTIME:-cc}"

JSONL=""
SESSION_ID=""
DRY_RUN=0
# Workspace the distiller runs in. Resolved (unless WORKSPACE_CWD is set in the env)
# from the user's config.yaml — an explicit `workspace_path`, else the parent of
# `knowledge_base_path` (the KB lives at <workspace>/memory/). Mirrors core's config.ts
# resolution and keeps NO hardcoded path in the repo (the real value is the user's local
# config). The literal placeholder is only a last resort when config can't be read.
# NB: pure sed + shell (no python heredoc inside $() — that breaks macOS' /bin/bash 3.2).
_ka_config="${KA_CONFIG:-$KA_CONFIG_DIR/config.yaml}"
if [ -z "${WORKSPACE_CWD:-}" ] && [ -f "$_ka_config" ]; then
    _read_cfg() {  # $1=key → first value, trailing space stripped
        sed -n "s/^[[:space:]]*$1[[:space:]]*:[[:space:]]*//p" "$_ka_config" | head -1 | sed 's/[[:space:]]*$//'
    }
    _ws="$(_read_cfg workspace_path)"; _ws="${_ws#\"}"; _ws="${_ws%\"}"
    if [ -z "$_ws" ]; then
        _kb="$(_read_cfg knowledge_base_path)"; _kb="${_kb#\"}"; _kb="${_kb%\"}"; _kb="${_kb%/}"
        [ -n "$_kb" ] && _ws="$(dirname "$_kb")"
    fi
    case "$_ws" in "~") _ws="$HOME" ;; "~/"*) _ws="$HOME/${_ws#\~/}" ;; esac
    [ -n "$_ws" ] && WORKSPACE_CWD="$_ws"
fi
WORKSPACE_CWD="${WORKSPACE_CWD:-$HOME/workspace/your-workspace}"

usage() {
    cat <<EOF
ka kb distill --background — spawn background Opus distiller

USAGE
    ka kb distill --background --jsonl <abs path> [--session-id <uuid>] [--dry-run]

FLAGS
    --jsonl <path>        Absolute path to the session .jsonl (required)
    --session-id <uuid>   Override (default: derive from jsonl filename)
    --dry-run             Print the planned spawn but do not actually spawn
    -h, --help            Show this help

OUTPUT (stdout, single line)
    distill-bg: pid=<N> log=<path> status=<state-file> snapshot=<bytes>
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --jsonl)        JSONL="${2:?--jsonl requires value}"; shift 2 ;;
        --session-id)   SESSION_ID="${2:?--session-id requires value}"; shift 2 ;;
        --dry-run)      DRY_RUN=1; shift ;;
        -h|--help)      usage; exit 0 ;;
        *) log_err "unknown flag: $1"; usage >&2; exit 1 ;;
    esac
done

# Scheduled runtime-neutral distillation has no interactive caller to provide a
# transcript path. Resolve the canonical main session recorded by Workshop.
# Explicit --jsonl always wins and remains useful for recovery/debug runs.
if [ -z "$JSONL" ]; then
    case "$KA_DISTILL_RUNTIME" in
        codex)
            _thread_file="$KA_STATE_DIR/codex-app-servers/main.thread"
            _thread_id="$(tr -d '[:space:]' < "$_thread_file" 2>/dev/null || true)"
            [ -n "$_thread_id" ] || { log_err "canonical Codex main thread not found: $_thread_file"; exit 2; }
            JSONL="$(find "${CODEX_HOME:-$HOME/.codex}/sessions" -type f -name "*${_thread_id}*.jsonl" -print 2>/dev/null | head -1)"
            SESSION_ID="${SESSION_ID:-$_thread_id}"
            ;;
        cc)
            _lead_file="$KA_STATE_DIR/lead-session.id"
            _lead_id="$(tr -d '[:space:]' < "$_lead_file" 2>/dev/null || true)"
            [ -n "$_lead_id" ] || { log_err "canonical Claude lead session not found: $_lead_file"; exit 2; }
            JSONL="$(find "$HOME/.claude/projects" -type f -name "${_lead_id}.jsonl" -print 2>/dev/null | head -1)"
            SESSION_ID="${SESSION_ID:-$_lead_id}"
            ;;
        *) log_err "unsupported distill runtime: $KA_DISTILL_RUNTIME"; exit 2 ;;
    esac
fi
[ -n "$JSONL" ] || { log_err "canonical $KA_DISTILL_RUNTIME transcript file not found"; exit 2; }
[ -f "$JSONL" ] || { log_err "jsonl not found: $JSONL"; exit 2; }

# Derive session_id from jsonl filename if not given.
if [ -z "$SESSION_ID" ]; then
    SESSION_ID="$(basename "$JSONL" .jsonl)"
fi

STATE_DIR="$KA_STATE_DIR"
mkdir -p "$STATE_DIR" || { log_err "cannot create $STATE_DIR"; exit 2; }

# Log rotation: each real background distill leaves a distill-<ts>.log. Dry-run
# must remain strictly read-only and therefore skips pruning.
if [ "$DRY_RUN" -eq 0 ]; then
    # Keep the newest 30. `|| true` keeps a first-ever empty state dir safe
    # under pipefail.
    { ls -1t "$STATE_DIR"/distill-*.log 2>/dev/null || true; } | tail -n +31 | while IFS= read -r old_log; do
        rm -f "$old_log"
    done
fi

# Refuse to spawn if a worker is already running.
STATUS_FILE="$STATE_DIR/distill-current.json"
if [ -f "$STATUS_FILE" ]; then
    EXISTING_STATUS="$(awk -F'"' '/"status":/ {print $4; exit}' "$STATUS_FILE" 2>/dev/null || true)"
    EXISTING_PID="$(awk -F'[:,]' '/"pid":/ {gsub(/[^0-9]/, "", $2); print $2; exit}' "$STATUS_FILE" 2>/dev/null || true)"
    if [ "${EXISTING_STATUS:-}" = "running" ] && [ -n "${EXISTING_PID:-}" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
        log_err "another distill worker is already running (pid=$EXISTING_PID, status=running)"
        log_err "wait for it to finish, or check $STATUS_FILE"
        exit 2
    fi
fi

# Locate ka-jsonl-reader CLI bundle. Core CLI bundle (self-contained tsup output, deployed verbatim to /kb/core/dist).
# layout) or kb/core/dist (repo layout) — try both.
if [ "$KA_DISTILL_RUNTIME" = "codex" ]; then
    JSONL_READER="$KA_HOME/kb/core/dist/codex-rollout-reader-cli.js"
    [ -f "$JSONL_READER" ] || JSONL_READER="$KA_HOME/kb/adapter-codex/dist/rollout-reader-cli.js"
else
    JSONL_READER="$KA_HOME/kb/core/dist/jsonl-reader-cli.js"
fi
[ -f "$JSONL_READER" ] || { log_err "jsonl-reader bundle missing — run './install.sh --only core-cli' (or 'pnpm --filter @ka/core build' in repo) ($JSONL_READER)"; exit 2; }

# Capture snapshot via the lightweight --format snapshot path (no message body)
# and parse the three progress fields via Node (jq may not be installed).
SNAPSHOT_LINE="$(node "$JSONL_READER" --jsonl "$JSONL" --format snapshot 2>/dev/null \
    | node -e 'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{try{const j=JSON.parse(d); process.stdout.write(`${j.progress.offset}\t${j.progress.lastEntryUuid}\t${j.progress.messageCount}`)}catch{process.exit(2);}})' || true)"

if [ -z "$SNAPSHOT_LINE" ]; then
    log_err "failed to capture snapshot from $JSONL"
    exit 2
fi
SNAPSHOT_OFFSET="$(printf '%s' "$SNAPSHOT_LINE" | cut -f1)"
SNAPSHOT_UUID="$(printf '%s' "$SNAPSHOT_LINE" | cut -f2)"
SNAPSHOT_COUNT="$(printf '%s' "$SNAPSHOT_LINE" | cut -f3)"

TIMESTAMP_FILE="$(date -u +%Y%m%dT%H%M%SZ)"
TIMESTAMP_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG_PATH="$STATE_DIR/distill-${TIMESTAMP_FILE}.log"

WORKER="$KA_KB_DIR/distill-bg-worker.sh"
[ -f "$WORKER" ] || { log_err "worker missing: $WORKER"; exit 2; }

if [ "$DRY_RUN" -eq 1 ]; then
    cat <<EOF
distill-bg dry-run:
  jsonl=$JSONL
  session_id=$SESSION_ID
  snapshot.offset=$SNAPSHOT_OFFSET
  snapshot.uuid=$SNAPSHOT_UUID
  snapshot.count=$SNAPSHOT_COUNT
  log_path=$LOG_PATH
  state_file=$STATUS_FILE
  worker=$WORKER
  runtime=$KA_DISTILL_RUNTIME
  workspace_cwd=$WORKSPACE_CWD
EOF
    exit 0
fi

# Write initial status (pid filled by worker once it starts).
cat > "$STATUS_FILE" <<EOF
{
  "pid": null,
  "start_time": "$TIMESTAMP_ISO",
  "status": "starting",
  "raw_added": null,
  "conversations_updated": null,
  "topics_updated": null,
  "snapshot_offset": $SNAPSHOT_OFFSET,
  "snapshot_uuid": "$SNAPSHOT_UUID",
  "snapshot_count": $SNAPSHOT_COUNT,
  "session_id": "$SESSION_ID",
  "jsonl_path": "$JSONL",
  "log_path": "$LOG_PATH",
  "workspace_cwd": "$WORKSPACE_CWD",
  "runtime": "$KA_DISTILL_RUNTIME"
}
EOF

# Spawn worker fully detached. Redirect stdin from /dev/null so the worker
# doesn't inherit the parent's stdin.
nohup "$WORKER" \
    --jsonl "$JSONL" \
    --session-id "$SESSION_ID" \
    --snapshot-offset "$SNAPSHOT_OFFSET" \
    --snapshot-uuid "$SNAPSHOT_UUID" \
    --snapshot-count "$SNAPSHOT_COUNT" \
    --log-path "$LOG_PATH" \
    --status-file "$STATUS_FILE" \
    --workspace-cwd "$WORKSPACE_CWD" \
    </dev/null >/dev/null 2>&1 &
WORKER_PID=$!

# Record the child pid but leave status=`starting`. The worker changes it to
# `running` only after argument parsing and runtime-adapter initialization.
TMP_STATUS="${STATUS_FILE}.tmp.$$"
node -e '
const fs = require("fs");
const f = process.argv[1];
const pid = Number(process.argv[2]);
const j = JSON.parse(fs.readFileSync(f, "utf-8"));
j.pid = pid;
fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$STATUS_FILE" "$WORKER_PID"

# Bounded startup handshake. A missing runtime adapter, bad shebang, or other
# preflight failure must be reported now instead of leaving stale `running`
# state for every later scheduled run.
WORKER_STATUS="starting"
for _ in $(seq 1 20); do
    WORKER_STATUS="$(awk -F'"' '/"status":/ {print $4; exit}' "$STATUS_FILE" 2>/dev/null || true)"
    [ "$WORKER_STATUS" != "starting" ] && break
    kill -0 "$WORKER_PID" 2>/dev/null || break
    sleep 0.05
done
if [ "$WORKER_STATUS" = "starting" ]; then
    node -e '
const fs = require("fs");
const f = process.argv[1];
const j = JSON.parse(fs.readFileSync(f, "utf8"));
Object.assign(j, {status: "failed", exit_code: 78, end_time: new Date().toISOString(), parse_tier: null, parse_notes: "distill worker exited before startup handshake"});
fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$STATUS_FILE"
    log_err "distill worker exited before startup handshake (pid=$WORKER_PID)"
    exit 2
fi

printf 'distill-bg: pid=%s log=%s status=%s snapshot=%s\n' \
    "$WORKER_PID" "$LOG_PATH" "$STATUS_FILE" "$SNAPSHOT_OFFSET"
