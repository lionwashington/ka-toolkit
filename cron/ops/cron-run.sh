#!/bin/bash
# cron-run.sh — unified trigger entrypoint for ka cron jobs.
#
# Invoked by launchd/systemd. Responsibilities:
#   1. Resolve <name> in ~/.knowledge-assistant/cron.yaml
#   2. Acquire per-name flock (default) to prevent overlap
#   3. Run the job by kind: shell | inject-prompt | ka-cli
#   4. Log to ~/Library/Logs/knowledge-assistant/cron/<name>.log (stdout+stderr)
#
# Usage: cron-run.sh <name> [--foreground]
#   --foreground: write output to stdout/stderr too (for `ka cron run` debugging).

set -uo pipefail

# cron fires with a minimal env (esp. crontab on Linux: PATH=/usr/bin:/bin, no
# nvm). Source nvm + add ~/.local/bin so node / uv / ka resolve. Harmless on macOS
# (launchd also benefits). Defensive: no-op if nvm absent.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
export PATH="$HOME/.local/bin:$PATH"

NAME="${1:?job name required}"
FOREGROUND=0
shift || true
while [ $# -gt 0 ]; do
    case "$1" in
        --foreground) FOREGROUND=1 ;;
    esac
    shift
done

: "${KA_HOME:=$HOME/.knowledge-assistant}"
export KA_HOME
# shellcheck source=../cli/common.sh
source "$KA_HOME/shared/ops/common.sh"
REPO_ROOT="$KA_HOME"   # back-compat alias used below

CRON_YAML="${KA_CRON_CONFIG:-$KA_CONFIG_DIR/cron.yaml}"
if [ ! -f "$CRON_YAML" ]; then
    echo "cron-run: cron.yaml not found at $CRON_YAML" >&2
    exit 64
fi

LOG_DIR="${KA_CRON_LOG_DIR:-$HOME/Library/Logs/knowledge-assistant/cron}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${NAME}.log"
LOCK_DIR="${KA_CRON_LOCK_DIR:-$KA_STATE_DIR/cron-locks}"
mkdir -p "$LOCK_DIR"
LOCK_FILE="$LOCK_DIR/${NAME}.lock"

# --- Parse cron.yaml, extract fields for <name> ------------------------------
PARSE="$KA_CRON_INTERNALS_DIR/parse-yaml.sh"
[ -x "$PARSE" ] || chmod +x "$PARSE" 2>/dev/null || true

schedule=""; kind="shell"; command_str=""
enabled="true"; flock_mode="per-name"
declare -a env_pairs=()

while IFS=$'\t' read -r rec_kind a b c; do
    [ -z "$rec_kind" ] && continue
    case "$rec_kind" in
        job)
            [ "$a" = "$NAME" ] || continue
            case "$b" in
                schedule)    schedule="$c" ;;
                kind)        kind="$c" ;;
                command)     command_str="$c" ;;
                enabled)     enabled="$c" ;;
                flock)       flock_mode="$c" ;;
            esac
            case "$b" in
                env_*)
                    key="${b#env_}"
                    env_pairs+=("$key=$c")
                    ;;
            esac
            ;;
    esac
done < <(bash "$PARSE" "$CRON_YAML" 2>/dev/null)

if [ -z "$command_str" ]; then
    echo "cron-run: job '$NAME' not found in $CRON_YAML" >&2
    exit 65
fi

case "$enabled" in
    false|0|no) echo "cron-run: job '$NAME' is disabled; skipping" >&2; exit 0 ;;
esac

# --- Build wrapped command ---------------------------------------------------
run_cmd() {
    case "$kind" in
        shell)
            bash -c "$command_str"
            ;;
        inject-prompt)
            local inject="$KA_WORKSHOP_DIR/inject-prompt.sh"
            [ -x "$inject" ] || { echo "missing $inject" >&2; return 127; }
            # shellcheck source=../lib/tmux-helpers.sh
            source "$KA_WORKSHOP_DIR/tmux-helpers.sh"
            # Target channels are read from config.yaml — the single fail-closed
            # source (config-cli). cron.yaml no longer carries target_pane.
            local node_bin; node_bin="$(command -v node || echo /opt/homebrew/bin/node)"
            local cfgcli="$REPO_ROOT/kb/core/dist/config-cli.js"
            local channels; channels="$("$node_bin" "$cfgcli" inject 2>/dev/null || true)"
            if [ -z "$channels" ]; then
                echo "inject-prompt: channels.inject empty/unset — nothing injected (fail-closed)" >&2
                return 1
            fi
            local ch pane injected=0
            while IFS= read -r ch; do
                [ -n "$ch" ] || continue
                # A Codex cron turn enters through Channel rather than tmux so
                # its final response is delivered to the Telegram/Lark owner.
                local port="${KA_CHANNEL_PORT:-9877}" status body
                status="$(curl -sf --max-time 2 "http://127.0.0.1:$port/api/status" 2>/dev/null || true)"
                if printf '%s' "$status" | CHANNEL_NAME="$ch" "$node_bin" -e '
let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.runtime_targets?.some(x=>x.name===process.env.CHANNEL_NAME&&x.runtime==="codex"&&x.alive)?0:1)}catch{process.exit(1)}})
' 2>/dev/null; then
                    body="$(PROMPT_TEXT="$command_str" "$node_bin" -e 'process.stdout.write(JSON.stringify({content:process.env.PROMPT_TEXT}))')"
                    if curl -sf -H 'content-type: application/json' -d "$body" \
                        "http://127.0.0.1:$port/api/runtimes/codex/$ch/deliver" >/dev/null; then
                        injected=1
                    else
                        echo "inject-prompt: Codex Channel delivery failed for '$ch'" >&2
                    fi
                    continue
                fi
                pane="$(tmux_pane_for_channel "$ch" || true)"
                if [ -z "$pane" ]; then
                    echo "inject-prompt: channel '$ch' has no running pane — skipping" >&2
                    continue
                fi
                "$inject" "$pane" "$command_str" && injected=1
            done <<< "$channels"
            if [ "$injected" != 1 ]; then
                echo "inject-prompt: no pane resolved for channels.inject — nothing injected" >&2
                return 1
            fi
            ;;
        ka-cli)
            local ka="$KA_HOME/shared/bin/ka"
            [ -x "$ka" ] || { echo "missing $ka" >&2; return 127; }
            # shellcheck disable=SC2086
            local output rc
            set +e
            output="$("$ka" $command_str 2>&1)"
            rc=$?
            set -e
            printf '%s\n' "$output"
            [ "$rc" -eq 0 ] || return "$rc"

            # A launchd/cron runner that exits immediately may take a detached
            # child with it. Keep the scheduled job alive until the distill
            # worker finishes, then validate its durable result instead of
            # recording the spawn itself as success.
            if [ "$command_str" = "kb distill --background" ]; then
                local worker_pid
                worker_pid="$(printf '%s\n' "$output" | sed -n 's/^distill-bg: pid=\([0-9][0-9]*\).*/\1/p' | tail -1)"
                [ -n "$worker_pid" ] || { echo "kb-distill: worker pid missing from spawn output" >&2; return 1; }
                while kill -0 "$worker_pid" 2>/dev/null; do sleep 2; done
                local state="$KA_STATE_DIR/distill-current.json" verdict
                verdict="$(node -e '
const fs=require("fs");
try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).status || "unknown")); }
catch { process.stdout.write("missing"); }
' "$state")"
                printf 'kb-distill: worker %s finished with status=%s\n' "$worker_pid" "$verdict"
                case "$verdict" in done|done-stats-unknown) ;; *) return 1 ;; esac
            fi
            ;;
        *)
            echo "cron-run: unknown kind '$kind'" >&2
            return 64
            ;;
    esac
}

# Export env pairs
for p in "${env_pairs[@]+"${env_pairs[@]}"}"; do
    export "$p"
done

TS_START="$(date '+%Y-%m-%d %H:%M:%S')"

do_run() {
    printf '=== %s start name=%s kind=%s ===\n' "$TS_START" "$NAME" "$kind"
    run_cmd
    local rc=$?
    printf '=== %s exit=%d name=%s ===\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$rc" "$NAME"
    return $rc
}

run_with_lock() {
    if [ "$flock_mode" = "none" ]; then
        do_run
        return $?
    fi
    # flock: portable fallback via mkdir if flock(1) unavailable.
    if command -v flock >/dev/null 2>&1; then
        (
            flock -n 9 || { echo "cron-run: '$NAME' already running; skipping"; exit 0; }
            do_run
        ) 9>"$LOCK_FILE"
        return $?
    fi
    # mkdir-based fallback (macOS default ships no flock(1))
    if mkdir "$LOCK_FILE.d" 2>/dev/null; then
        trap 'rmdir "$LOCK_FILE.d" 2>/dev/null || true' EXIT
        do_run
        return $?
    else
        echo "cron-run: '$NAME' already running (lockdir exists); skipping" >&2
        return 0
    fi
}

if [ "$FOREGROUND" -eq 1 ]; then
    run_with_lock
    exit $?
else
    run_with_lock >>"$LOG_FILE" 2>&1
    exit $?
fi
