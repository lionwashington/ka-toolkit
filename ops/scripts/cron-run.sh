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

KA_REPO_ROOT="${KA_REPO_ROOT:-$(_d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; until [ -e "$_d/bin/ka" ] || [ "$_d" = / ]; do _d="$(dirname "$_d")"; done; printf %s "$_d")}"
export KA_REPO_ROOT
# shellcheck source=../cli/common.sh
source "$KA_REPO_ROOT/ops/cli/common.sh"
REPO_ROOT="$KA_REPO_ROOT"   # back-compat alias used below

CRON_YAML="${KA_CRON_CONFIG:-$HOME/.knowledge-assistant/cron.yaml}"
if [ ! -f "$CRON_YAML" ]; then
    echo "cron-run: cron.yaml not found at $CRON_YAML" >&2
    exit 64
fi

LOG_DIR="${KA_CRON_LOG_DIR:-$HOME/Library/Logs/knowledge-assistant/cron}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${NAME}.log"
LOCK_DIR="${KA_CRON_LOCK_DIR:-$HOME/.knowledge-assistant/state/cron-locks}"
mkdir -p "$LOCK_DIR"
LOCK_FILE="$LOCK_DIR/${NAME}.lock"

# --- Parse cron.yaml, extract fields for <name> ------------------------------
PARSE="$KA_CRON_LIB_DIR/parse-yaml.sh"
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
            local inject="$KA_LIB_DIR/inject-prompt.sh"
            [ -x "$inject" ] || { echo "missing $inject" >&2; return 127; }
            # shellcheck source=../lib/tmux-helpers.sh
            source "$KA_LIB_DIR/tmux-helpers.sh"
            # Target channels are read from config.yaml — the single fail-closed
            # source (config-cli). cron.yaml no longer carries target_pane.
            local node_bin; node_bin="$(command -v node || echo /opt/homebrew/bin/node)"
            local cfgcli="$REPO_ROOT/core-cli/config-cli.js"          # runtime layout
            [ -f "$cfgcli" ] || cfgcli="$REPO_ROOT/kb/core/dist/config-cli.js"  # repo layout
            local channels; channels="$("$node_bin" "$cfgcli" inject 2>/dev/null || true)"
            if [ -z "$channels" ]; then
                echo "inject-prompt: channels.inject empty/unset — nothing injected (fail-closed)" >&2
                return 0
            fi
            local ch pane injected=0
            while IFS= read -r ch; do
                [ -n "$ch" ] || continue
                pane="$(tmux_pane_for_channel "$ch" || true)"
                if [ -z "$pane" ]; then
                    echo "inject-prompt: channel '$ch' has no running pane — skipping" >&2
                    continue
                fi
                "$inject" "$pane" "$command_str" && injected=1
            done <<< "$channels"
            [ "$injected" = 1 ] || echo "inject-prompt: no pane resolved for channels.inject — nothing injected" >&2
            ;;
        ka-cli)
            local ka="$REPO_ROOT/bin/ka"
            [ -x "$ka" ] || { echo "missing $ka" >&2; return 127; }
            # shellcheck disable=SC2086
            "$ka" $command_str
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
