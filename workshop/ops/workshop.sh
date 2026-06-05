#!/bin/bash
# ka workshop — the single entry point for managing the workshop (a set of
# independent CC processes, each in its own tmux pane + cwd, talking to the
# owner through the telegram-channel daemon).
#
# Verbs (P2 startup convergence, docs/P2_STARTUP_CONVERGENCE.md §6):
#   ka workshop [--pane|--window]
#       bare = `ka workshop start` (no name): launch every mate with default=true.
#   (daemon lifecycle is NOT here — use `ka daemon start|stop|restart|status`.)
#   ka workshop start [<name>]
#       no name  → launch all default=true.
#       <name>   → not in yaml: report missing; in yaml: launch into tmux if not
#                  already up, else report already running. (pure launcher,
#                  never registers a new mate)
#   ka workshop stop [<name>]
#       no name  → stop the whole workshop (kill session).
#       <name>   → session down: report not running; name not in tmux: report
#                  missing; in tmux: stop just that pane.
#   ka workshop restart <name>
#       restart a single mate's pane (stop that pane + start <name>). For when a
#       CC is stuck / needs a cwd change / state reset. ⚠️ loses that CC's runtime
#       context (--resume only restores the on-disk transcript); if you just need
#       to reconnect a dropped channel without losing context, DON'T restart —
#       trigger a tool call in that CC's window to re-init (telegram-channel-design A5).
#   ka workshop spawn-mates <name> [<workdir>]
#       with <workdir> = registrar (add/replace yaml + launch). [P2 step ②]
#       without        = alias for `ka workshop start <name>`.
#   ka workshop peek <name> [lines]    capture-pane: see a pane's live screen (READ; safe)
#   ka workshop poke <name> <keys…>    send-keys: unstick a hung pane (WRITE; recovery only)
#       out-of-band fallback for when the channel can't reach a pane; normal comms = the channel.
#
# Each CC gets its own tmux pane, its own cwd (`-c`), and its own KA_CHANNEL —
# separate processes, separate working dirs, separate channels. No cwd/context is
# shared; the layout (pane/window) is PURELY a visual choice. The owner drives
# each CC from Telegram with `to <name>: …` (no-prefix → "main").
#
# Env:
#   KA_CHANNEL_PORT  telegram-channel daemon port (default 9877)
#   OPS_CONFIG       override workshop.yaml path
set -euo pipefail

: "${KA_HOME:=$HOME/.knowledge-assistant}"
source "$KA_HOME/shared/ops/common.sh"
# shellcheck source=../lib/tmux-helpers.sh
source "$KA_WORKSHOP_DIR/tmux-helpers.sh"

YAML_PARSE="$KA_WORKSHOP_DIR/yaml-parse.sh"
START_PANE="$KA_WORKSHOP_DIR/start-pane.sh"
# Channel kind + port = single source of truth: config.yaml channel_kind +
# channels.<kind>.port (resolved in common.sh). Daemon dir is
# <kind>-daemon. The lead passes kind+port to each pane's CC child via env
# (the start-pane launch below) — that internal hand-off is the only place a
# channel env var is set, and its values originate from config.
CHANNEL_KIND="$(ka_channel_kind)" || exit 2
PORT="$(ka_channel_port)"
DAEMON_DIR="$(ka_daemon_dir)"
DAEMON_START="$DAEMON_DIR/start.sh"

# ---- verb + flags -----------------------------------------------------------
DRY_RUN="${DRY_RUN:-0}"
INCLUDE_OPTIONAL=0
ONLY=""
SKIP_DAEMON=0     # --skip-daemon → don't even check the daemon (workshop never manages it)
LAYOUT="pane"     # default (P2): all CCs as split-panes in ONE window (one screen).
                  # --window → one tmux window per CC (Ctrl-b 0/1/2/w to switch).

VERB="start"
case "${1:-}" in
    start|stop|restart|spawn-mates|peek|poke) VERB="$1"; shift ;;
esac

declare -a POSITIONAL
prev_arg=""
for arg in "$@"; do
    case "$arg" in
        --dry-run)        DRY_RUN=1 ;;
        --all)            INCLUDE_OPTIONAL=1 ;;
        --only=*)         ONLY="${arg#--only=}" ;;
        --only)           : ;;  # value picked up below
        --skip-daemon)    SKIP_DAEMON=1 ;;
        --pane)           LAYOUT="pane" ;;
        --window)         LAYOUT="window" ;;
        --*)              log_warn "unknown flag: $arg" ;;
        *)
            if [ "$prev_arg" = "--only" ]; then ONLY="$arg"
            else POSITIONAL+=("$arg"); fi
            ;;
    esac
    prev_arg="$arg"
done
TARGET="${POSITIONAL[0]:-}"      # <name> for start/stop/spawn-mates/peek/poke
WORKDIR_ARG="${POSITIONAL[1]:-}" # <workdir> for spawn-mates

# ---- peek / poke: out-of-band tmux inspection + recovery of a CC pane ---------
# Out-of-band path for when the channel can't reach a pane (a hung/unresponsive CC).
#   ka workshop peek <name> [lines]   capture-pane → see the pane's live screen (READ; always safe)
#   ka workshop poke <name> <keys…>   send-keys → nudge/unstick a hung pane (WRITE; deliberate only)
# <name> is a channel name (e.g. main) or a raw tmux target. Normal CC↔CC comms stay on the channel.
if [ "$VERB" = "peek" ] || [ "$VERB" = "poke" ]; then
    tmux_require || { log_err "tmux not available"; exit 1; }
    [ -n "$TARGET" ] || { log_err "usage: ka workshop $VERB <name> [...]"; exit 2; }
    # sanitize identically to the channel name (sanitize_channel is defined later in
    # this file, so inline it here to avoid an ordering dependency).
    PEEK_NAME="$(printf '%s' "$TARGET" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')"
    PEEK_PANE="$(tmux_pane_for_channel "$PEEK_NAME" 2>/dev/null || true)"
    if [ -z "$PEEK_PANE" ] && tmux_pane_exists "$TARGET"; then PEEK_PANE="$TARGET"; fi
    if [ -z "$PEEK_PANE" ]; then
        log_err "no workshop pane for '$TARGET'. Online channels:"
        "$TMUX_BIN" list-panes -a -F '  #{@ka_channel}  (#{session_name}:#{window_index}.#{pane_index})' 2>/dev/null | grep -vE '^\s+\(' || true
        exit 1
    fi
    if [ "$VERB" = "peek" ]; then
        PEEK_LINES="${POSITIONAL[1]:-60}"
        "$TMUX_BIN" capture-pane -p -t "$PEEK_PANE" -S "-${PEEK_LINES}"
        exit 0
    fi
    # poke: pass everything after <name> straight to send-keys (so `Enter`, `C-c`,
    # `Escape`, or literal text all work, e.g. `poke main Enter`, `poke main /clear Enter`).
    POKE_KEYS=("${POSITIONAL[@]:1}")
    [ ${#POKE_KEYS[@]} -gt 0 ] || { log_err "usage: ka workshop poke <name> <keys…>   e.g. poke main Enter"; exit 2; }
    log_info "poke ${TARGET} (${PEEK_PANE}): send-keys ${POKE_KEYS[*]}"
    "$TMUX_BIN" send-keys -t "$PEEK_PANE" "${POKE_KEYS[@]}"
    exit 0
fi

# ---- shared helpers ---------------------------------------------------------
# sanitize a channel name identically to the daemon's sanitizeChannelName.
sanitize_channel() {
    local s
    s="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')"
    [ -z "$s" ] && s="main"
    printf '%s' "$s"
}

# resume rule: respect an existing --resume; else default to latest.
ensure_resume() {
    RESUMED_ARGS=()
    local has=0
    local args=("$@")
    local i=0 n=$#
    while [ "$i" -lt "$n" ]; do
        if [ "${args[$i]}" = "--resume" ]; then has=1; fi
        RESUMED_ARGS+=("${args[$i]}"); i=$((i + 1))
    done
    if [ "$has" -eq 0 ]; then RESUMED_ARGS+=(--resume latest); fi
}

join_args() {
    # join "$@" with '|' into JOINED (empty string if none)
    JOINED=""
    local a first=1
    for a in "$@"; do
        if [ "$first" -eq 1 ]; then JOINED="$a"; first=0; else JOINED="$JOINED|$a"; fi
    done
}

run_tmux() {
    if [ "$DRY_RUN" = "1" ]; then echo "[dry-run] $TMUX_BIN $*"; else "$TMUX_BIN" "$@"; fi
}

# Build the shell command for one pane: KA_CHANNEL env + start-pane.sh + args.
build_channel_cmd() {
    local pane_name="$1" cwd="$2" channel="$3" raw_args="$4"
    local cmd
    printf -v cmd 'KA_CHANNEL=%q KA_CHANNEL_PORT=%q KA_CHANNEL_KIND=%q %q %q %q' \
        "$channel" "$PORT" "$CHANNEL_KIND" "$START_PANE" "$pane_name" "$cwd"
    if [ -n "$raw_args" ]; then
        local -a args; IFS='|' read -r -a args <<<"$raw_args"
        local a; for a in "${args[@]}"; do printf -v cmd '%s %q' "$cmd" "$a"; done
    fi
    printf '%s' "$cmd"
}

# ---- dev-channels confirmation gate auto-pass (bug1) ------------------------
# claude 2.1.156 forces an interactive "Loading development channels" gate for
# server: MCP channels (telegram-channel). No flag/env/config bypass exists. So
# we auto-pass it CONDITION-BASED: poll capture-pane until the gate's own text
# appears, THEN send Enter once (its default highlight is "1. I am using this for
# local development", so a bare Enter confirms). We NEVER send a timed blind
# Enter — detection of the gate text is the trigger. Markers are constants so
# they survive claude rewording the gate.
GATE_MARKER_PRIMARY="I am using this for local development"
GATE_MARKER_FALLBACK="Enter to confirm"
GATE_CONFIRM_TIMEOUT="${KA_GATE_TIMEOUT:-18}"   # seconds to watch one pane

auto_confirm_dev_gate() {
    local pane="$1" name="$2"
    local waited=0 cap
    while [ "$waited" -lt "$GATE_CONFIRM_TIMEOUT" ]; do
        cap="$("$TMUX_BIN" capture-pane -p -t "$pane" 2>/dev/null || true)"
        if printf '%s' "$cap" | grep -qF "$GATE_MARKER_PRIMARY" \
           || printf '%s' "$cap" | grep -qF "$GATE_MARKER_FALLBACK"; then
            "$TMUX_BIN" send-keys -t "$pane" Enter
            log_ts "auto-confirmed dev-channels gate on pane $pane ($name)"
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    log_warn "dev-channels gate not detected on pane $pane ($name) within ${GATE_CONFIRM_TIMEOUT}s — may not have appeared, already passed, or claude still starting; skipping (manual Enter may be needed)"
    return 0
}

# ---- parse config (shared by all verbs) -------------------------------------
CONFIG="$(resolve_workshop_config)"
if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
    log_err "no workshop config found (set OPS_CONFIG or create ~/.knowledge-assistant/workshop.yaml)"
    exit 3
fi
case "$CONFIG" in
    "$KA_CONFIG_DIR/workshop.example.yaml")
        log_warn "using repo template $CONFIG — create ~/.knowledge-assistant/workshop.yaml for personal layout" ;;
esac

tmux_require

SESSION=""
# Explicitly initialize as empty arrays: under set -u, `declare -a foo` (without
# =()) still makes `${#foo[@]}` report "unbound variable" when never assigned
# (e.g. workshop.yaml has no mate → MATE_NAMES is never appended to).
declare -a PANE_NAMES=() PANE_CWDS=() PANE_MAINS=() PANE_ARGS=()
declare -a MATE_NAMES=() MATE_CWDS=() MATE_DEFAULTS=() MATE_ARGS=()
while IFS= read -r rec; do
    [ -z "$rec" ] && continue
    # tab is an IFS-whitespace char, so `read` folds consecutive tabs and drops
    # empty fields (e.g. a mate with no desc → default field gets eaten). Swap
    # tabs for unit-separator (\x1f, non-whitespace) so empty fields survive.
    rec_safe="${rec//$'\t'/$'\x1f'}"
    IFS=$'\x1f' read -r kind a b c d <<<"$rec_safe"
    case "$kind" in
        session) SESSION="$a" ;;
        pane)
            PANE_NAMES+=("$a"); PANE_CWDS+=("$b"); PANE_MAINS+=("$c"); PANE_ARGS+=("$d") ;;
        mate)
            # Keep MATE_ARGS parallel; a following mate_args record fills it in.
            MATE_NAMES+=("$a"); MATE_CWDS+=("$b"); MATE_DEFAULTS+=("$d"); MATE_ARGS+=("") ;;
        mate_args)
            # Emitted immediately after its own `mate` record → set the last slot.
            MATE_ARGS[$(( ${#MATE_NAMES[@]} - 1 ))]="$b" ;;
    esac
done < <("$YAML_PARSE" "$CONFIG")

if [ -z "$SESSION" ] || [ "${#PANE_NAMES[@]}" -eq 0 ]; then
    log_err "config parsed empty (session='$SESSION' panes=${#PANE_NAMES[@]})"
    exit 1
fi

in_only_list() {
    [ -z "$ONLY" ] && return 1
    local want="$1" item; IFS=',' read -ra items <<<"$ONLY"
    for item in "${items[@]}"; do [ "$item" = "$want" ] && return 0; done
    return 1
}

# Build the launch list (panes + filtered mates) into ENTRY_* parallel arrays.
# When TARGET is set, only that single mate/pane is kept (and forced in even if
# default=false). Sets ENTRY_NAMES/ENTRY_CWDS/ENTRY_CHANNELS/ENTRY_ARGS + skipped_optional.
build_entries() {
    ENTRY_NAMES=(); ENTRY_CWDS=(); ENTRY_CHANNELS=(); ENTRY_ARGS=()
    skipped_optional=0
    # TARGET → force-include that mate via ONLY, then prune to it below.
    local only_eff="$ONLY"
    [ -n "$TARGET" ] && only_eff="$TARGET"

    local i name cwd main raw channel
    for i in "${!PANE_NAMES[@]}"; do
        name="${PANE_NAMES[$i]}"; cwd="${PANE_CWDS[$i]}"
        main="${PANE_MAINS[$i]}"; raw="${PANE_ARGS[$i]}"
        if [ "$main" = "1" ]; then channel="main"; else channel="$(sanitize_channel "$name")"; fi
        # yaml args verbatim (yaml-parse no longer prepends --teammate-mode /
        # --channels — P2 ④ retired the team mechanism), just apply resume rule.
        local parsed=()
        if [ -n "$raw" ]; then IFS='|' read -r -a parsed <<<"$raw"; fi
        if [ "${#parsed[@]}" -gt 0 ]; then ensure_resume "${parsed[@]}"; else ensure_resume; fi
        if [ "${#RESUMED_ARGS[@]}" -gt 0 ]; then join_args "${RESUMED_ARGS[@]}"; else join_args; fi
        ENTRY_NAMES+=("$name"); ENTRY_CWDS+=("$cwd"); ENTRY_CHANNELS+=("$channel"); ENTRY_ARGS+=("$JOINED")
    done

    if [ "${#MATE_NAMES[@]}" -gt 0 ]; then
        for i in "${!MATE_NAMES[@]}"; do
            name="${MATE_NAMES[$i]}"; cwd="${MATE_CWDS[$i]}"
            if [ -n "$only_eff" ]; then
                local match=0 item; IFS=',' read -ra items <<<"$only_eff"
                for item in "${items[@]}"; do [ "$item" = "$name" ] && match=1; done
                [ "$match" = "1" ] || continue
            elif [ "${MATE_DEFAULTS[$i]}" = "0" ] && [ "$INCLUDE_OPTIONAL" -eq 0 ]; then
                skipped_optional=$((skipped_optional + 1)); continue
            fi
            # yaml args verbatim (same rule as panes), then apply the resume rule.
            raw="${MATE_ARGS[$i]}"
            local mparsed=()
            if [ -n "$raw" ]; then IFS='|' read -r -a mparsed <<<"$raw"; fi
            if [ "${#mparsed[@]}" -gt 0 ]; then ensure_resume "${mparsed[@]}"; else ensure_resume; fi
            if [ "${#RESUMED_ARGS[@]}" -gt 0 ]; then join_args "${RESUMED_ARGS[@]}"; else join_args; fi
            ENTRY_NAMES+=("$name"); ENTRY_CWDS+=("$cwd"); ENTRY_CHANNELS+=("$(sanitize_channel "$name")"); ENTRY_ARGS+=("$JOINED")
        done
    fi

    # TARGET → prune to the single entry whose name == TARGET (drops the main
    # pane that --only always carries). Missing → caller reports "not in yaml".
    if [ -n "$TARGET" ]; then
        local keep=-1 j
        for j in "${!ENTRY_NAMES[@]}"; do [ "${ENTRY_NAMES[$j]}" = "$TARGET" ] && keep=$j; done
        if [ "$keep" -lt 0 ]; then
            ENTRY_NAMES=(); return 0
        fi
        ENTRY_NAMES=("${ENTRY_NAMES[$keep]}"); ENTRY_CWDS=("${ENTRY_CWDS[$keep]}")
        ENTRY_CHANNELS=("${ENTRY_CHANNELS[$keep]}"); ENTRY_ARGS=("${ENTRY_ARGS[$keep]}")
    fi
}

# Find the tmux pane_id for a channel in SESSION (any window). Empty if none.
find_pane_by_channel() {
    local channel="$1"
    # -s = all panes in THIS session (every window). NOT -a: that lists EVERY
    # session server-wide (ignoring -t) and would cross-match another session's
    # channel — a dangerous mis-kill (e.g. killing the real `workshop` ka-dev2
    # pane when targeting a same-named channel in another session).
    "$TMUX_BIN" list-panes -s -t "$SESSION" -F '#{pane_id} #{@ka_channel}' 2>/dev/null \
        | awk -v c="$channel" '$2==c{print $1; exit}'
}

# ============================================================================
# cmd_start — launch all default=true mates, or a single <name> (TARGET).
# ============================================================================
cmd_start() {
    build_entries
    if [ -n "$TARGET" ] && [ "${#ENTRY_NAMES[@]}" -eq 0 ]; then
        log_err "'$TARGET' is not declared in workshop.yaml (session '$SESSION')"
        exit 1
    fi

    # ---- channel daemon: detect + warn only (workshop does NOT manage it) ---
    # Daemon lifecycle now lives entirely in `ka daemon`. The panes/CCs don't
    # depend on the daemon being up to launch — each CC connects (and re-adopts)
    # whenever the daemon is up — so workshop only WARNS if it's down, and never
    # starts / stops / restarts it. (--skip-daemon suppresses even the check.)
    if [ "$SKIP_DAEMON" -eq 0 ] && [ "$DRY_RUN" != "1" ]; then
        if ! curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
            log_warn "${CHANNEL_KIND} daemon not running (port $PORT) — channels won't connect until it's up. Start it: ka daemon start"
        fi
    elif [ "$SKIP_DAEMON" -eq 0 ] && [ "$DRY_RUN" = "1" ]; then
        echo "[dry-run] check ${CHANNEL_KIND} daemon on port $PORT; warn (only) if down — workshop does not start it (use: ka daemon start)"
    fi

    # ---- cwd existence check ------------------------------------------------
    local i
    for i in "${!ENTRY_NAMES[@]}"; do
        if [ ! -d "${ENTRY_CWDS[$i]}" ]; then
            log_err "entry '${ENTRY_NAMES[$i]}' cwd does not exist: ${ENTRY_CWDS[$i]}"
            exit 1
        fi
    done

    # ---- safety: don't bootstrap the session we're attached to --------------
    # Guards a FULL (re)build only (no TARGET): that re-creates every pane —
    # including the CC running this command — and would kill your attach. A
    # single-pane start/restart (TARGET set, e.g. `restart <name>`) just splits
    # one pane and never touches the rest of the attached session, so it's
    # exempt. Without this exemption `ka workshop restart <name>` from inside the
    # session would stop the pane then refuse to start it → leave that pane dead.
    if [ -z "$TARGET" ] && [ -n "${TMUX:-}" ]; then
        local cur_session; cur_session="$("$TMUX_BIN" display-message -p '#S' 2>/dev/null || true)"
        if [ "$cur_session" = "$SESSION" ] && [ "$DRY_RUN" != "1" ]; then
            log_err "refusing to (re)build session '$SESSION' while attached to it"
            log_dim "detach first (Ctrl-b d) or run from outside tmux (or use --dry-run)"
            exit 3
        fi
    fi

    # ---- create/repair session ----------------------------------------------
    local session_exists
    if "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
        log_ts "Session '$SESSION' already exists; adding missing panes only."
        session_exists=1
    else
        session_exists=0
    fi

    log_ts "ka workshop start: launching ${#ENTRY_NAMES[@]} CC(s) in session '$SESSION' [layout=$LAYOUT]$([ "${skipped_optional:-0}" -gt 0 ] && printf ' (skipped %s optional mate; --all to include)' "$skipped_optional")"

    # Idempotency keys per layout: pane → @ka_channel user-option; window → index.
    local existing_channels="" existing_windows=""
    if [ "$session_exists" = "1" ] && [ "$DRY_RUN" != "1" ]; then
        if [ "$LAYOUT" = "pane" ]; then
            existing_channels="$("$TMUX_BIN" list-panes -t "$SESSION:0" -F '#{@ka_channel}' 2>/dev/null || true)"
        else
            existing_windows="$("$TMUX_BIN" list-windows -t "$SESSION" -F '#{window_index}' 2>/dev/null || true)"
        fi
    fi

    local made_any=0
    declare -a CONFIRM_PANES CONFIRM_NAMES
    local name cwd channel args cmd new_pane_id
    for i in "${!ENTRY_NAMES[@]}"; do
        name="${ENTRY_NAMES[$i]}"; cwd="${ENTRY_CWDS[$i]}"
        channel="${ENTRY_CHANNELS[$i]}"; args="${ENTRY_ARGS[$i]}"

        if [ "$LAYOUT" = "pane" ]; then
            if printf '%s\n' "$existing_channels" | grep -qx "$channel"; then
                log_ts "Pane for '$name' (channel '$channel') exists — already running, skipping."; continue
            fi
        else
            if printf '%s\n' "$existing_windows" | grep -qx "$i"; then
                log_ts "Window $i ($name) exists — already running, skipping."; continue
            fi
        fi

        cmd="$(build_channel_cmd "$name" "$cwd" "$channel" "$args")"
        new_pane_id=""
        if [ "$LAYOUT" = "pane" ]; then
            if [ "$i" = "0" ] && [ "$session_exists" = "0" ]; then
                log_ts "Creating session '$SESSION' window 0, pane for $name (channel '$channel') at $cwd"
                if [ "$DRY_RUN" = "1" ]; then
                    echo "[dry-run] $TMUX_BIN new-session -d -s $SESSION -n $SESSION -c $cwd -- <start-pane: $name>"
                else
                    "$TMUX_BIN" new-session -d -s "$SESSION" -n "$SESSION" -c "$cwd" "$cmd"
                    new_pane_id="$("$TMUX_BIN" list-panes -t "$SESSION:0" -F '#{pane_id}' 2>/dev/null | head -1)"
                fi
            else
                log_ts "Adding split-pane to window 0 for $name (channel '$channel') at $cwd"
                if [ "$DRY_RUN" = "1" ]; then
                    echo "[dry-run] $TMUX_BIN split-window -d -P -F '#{pane_id}' -t $SESSION:0 -c $cwd -- <start-pane: $name>"
                else
                    # If the session didn't exist and this isn't entry 0 (e.g.
                    # `start <name>` for a single mate), create it first.
                    if ! "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
                        "$TMUX_BIN" new-session -d -s "$SESSION" -n "$SESSION" -c "$cwd" "$cmd"
                        new_pane_id="$("$TMUX_BIN" list-panes -t "$SESSION:0" -F '#{pane_id}' 2>/dev/null | head -1)"
                    else
                        new_pane_id="$("$TMUX_BIN" split-window -d -P -F '#{pane_id}' -t "$SESSION:0" -c "$cwd" "$cmd" 2>/dev/null || true)"
                        "$TMUX_BIN" select-layout -t "$SESSION:0" tiled >/dev/null 2>&1 || true
                    fi
                fi
            fi
        else
            if [ "$i" = "0" ] && [ "$session_exists" = "0" ]; then
                log_ts "Creating session '$SESSION' + window 0 ($name → channel '$channel') at $cwd"
                if [ "$DRY_RUN" = "1" ]; then
                    echo "[dry-run] $TMUX_BIN new-session -d -s $SESSION -n $name -c $cwd -- <start-pane: $name>"
                else
                    "$TMUX_BIN" new-session -d -s "$SESSION" -n "$name" -c "$cwd" "$cmd"
                    new_pane_id="$("$TMUX_BIN" list-panes -t "$SESSION:0" -F '#{pane_id}' 2>/dev/null | head -1)"
                fi
            else
                log_ts "Creating window $i ($name → channel '$channel') at $cwd"
                if [ "$DRY_RUN" = "1" ]; then
                    echo "[dry-run] $TMUX_BIN new-window -d -P -F '#{pane_id}' -t $SESSION:$i -n $name -c $cwd -- <start-pane: $name>"
                else
                    if ! "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
                        "$TMUX_BIN" new-session -d -s "$SESSION" -n "$name" -c "$cwd" "$cmd"
                        new_pane_id="$("$TMUX_BIN" list-panes -t "$SESSION:0" -F '#{pane_id}' 2>/dev/null | head -1)"
                    else
                        new_pane_id="$("$TMUX_BIN" new-window -d -P -F '#{pane_id}' -t "$SESSION" -n "$name" -c "$cwd" "$cmd" 2>/dev/null || true)"
                    fi
                fi
            fi
        fi
        if [ -n "$new_pane_id" ]; then
            "$TMUX_BIN" set-option -p -t "$new_pane_id" @ka_channel "$channel" 2>/dev/null || true
            CONFIRM_PANES+=("$new_pane_id"); CONFIRM_NAMES+=("$name")
        elif [ "$DRY_RUN" = "1" ]; then
            echo "[dry-run] would auto-confirm dev-channels gate for $name once its gate appears"
        fi
        made_any=1
    done

    # pane layout: even tiling + per-pane channel border labels.
    if [ "$LAYOUT" = "pane" ] && [ "$made_any" = "1" ] && [ "$DRY_RUN" != "1" ]; then
        "$TMUX_BIN" select-layout -t "$SESSION:0" tiled >/dev/null 2>&1 || true
        "$TMUX_BIN" set-option -w -t "$SESSION:0" pane-border-status top 2>/dev/null || true
        "$TMUX_BIN" set-option -w -t "$SESSION:0" pane-border-format ' #{@ka_channel} ' 2>/dev/null || true
    fi

    # bug1: auto-pass the dev-channels gate on every freshly-created pane.
    if [ "$DRY_RUN" != "1" ] && [ "${#CONFIRM_PANES[@]}" -gt 0 ]; then
        local ci
        for ci in "${!CONFIRM_PANES[@]}"; do
            auto_confirm_dev_gate "${CONFIRM_PANES[$ci]}" "${CONFIRM_NAMES[$ci]}"
        done
    fi

    if [ "$DRY_RUN" = "1" ]; then
        echo ""
        echo "── ka workshop start: dry-run summary (layout=$LAYOUT) ──"
        printf '  session: %s\n' "$SESSION"
        printf '  daemon : %s (port %s)\n' "$DAEMON_START" "$PORT"
        for i in "${!ENTRY_NAMES[@]}"; do
            printf '  [%s] %-14s cwd=%s  channel=%s  args=[%s]\n' \
                "$i" "${ENTRY_NAMES[$i]}" "${ENTRY_CWDS[$i]}" "${ENTRY_CHANNELS[$i]}" \
                "$(printf '%s' "${ENTRY_ARGS[$i]}" | tr '|' ' ')"
        done
        exit 0
    fi

    if [ "$made_any" = "0" ]; then
        if [ -n "$TARGET" ]; then log_ok "'$TARGET' already running in session '$SESSION'"
        else log_ok "ka workshop: all CCs already running in session '$SESSION'"; fi
    else
        echo ""
        log_ok "ka workshop start: launched (attach: tmux attach -t $SESSION)"
        log_dim "owner routes via Telegram: 'to <name>: …'  (no prefix → main)"
    fi
}

# ============================================================================
# cmd_stop — stop the whole workshop, or a single <name> (TARGET).
# ============================================================================
cmd_stop() {
    if ! "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
        if [ -n "$TARGET" ]; then log_err "workshop not running (no session '$SESSION')"; exit 1
        else log_dim "no session '$SESSION' — noop"; exit 0; fi
    fi

    if [ -n "$TARGET" ]; then
        # Stop a single mate's pane. The channel comes from the yaml's
        # name→channel mapping (build_entries: the main entry's channel is forced
        # to 'main'). A plain sanitize(name) would be wrong when mate name≠channel
        # — the main entry's channel is forced to 'main' by main:true.
        build_entries
        local channel
        if [ "${#ENTRY_NAMES[@]}" -gt 0 ]; then channel="${ENTRY_CHANNELS[0]}"; else channel="$(sanitize_channel "$TARGET")"; fi
        local pane_id; pane_id="$(find_pane_by_channel "$channel")"
        if [ -z "$pane_id" ]; then
            log_err "'$TARGET' (channel '$channel') is not running in session '$SESSION'"
            exit 1
        fi
        if [ "$DRY_RUN" = "1" ]; then
            echo "[dry-run] $TMUX_BIN send-keys -t $pane_id C-c; $TMUX_BIN kill-pane -t $pane_id"
            exit 0
        fi
        "$TMUX_BIN" send-keys -t "$pane_id" C-c 2>/dev/null || true
        sleep 1
        # C-c may already have closed the pane (if its process exits on SIGINT);
        # only kill-pane if it's still there. Either way the mate is stopped.
        if "$TMUX_BIN" list-panes -s -t "$SESSION" -F '#{pane_id}' 2>/dev/null | grep -qx "$pane_id"; then
            "$TMUX_BIN" kill-pane -t "$pane_id" 2>/dev/null || true
        fi
        "$TMUX_BIN" select-layout -t "$SESSION:0" tiled >/dev/null 2>&1 || true
        log_ok "stopped '$TARGET' (channel '$channel')"
        return 0
    fi

    # Stop the whole workshop (was `ka stop`).
    log_info "stopping session '$SESSION'"
    if [ "$DRY_RUN" = "1" ]; then
        echo "[dry-run] send C-c to all panes; $TMUX_BIN kill-session -t $SESSION"
        exit 0
    fi
    local pane_targets=() t
    while IFS= read -r t; do
        [ -n "$t" ] && pane_targets+=("$t")
    done < <("$TMUX_BIN" list-panes -t "$SESSION" -a -F '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
        | awk -F':' -v s="$SESSION" '$1==s')
    for t in "${pane_targets[@]:-}"; do
        [ -z "$t" ] && continue
        "$TMUX_BIN" send-keys -t "$t" C-c 2>/dev/null || true
    done
    sleep 1
    if "$TMUX_BIN" kill-session -t "$SESSION" 2>/dev/null; then
        log_ok "session '$SESSION' killed"
    else
        log_warn "kill-session '$SESSION' returned non-zero (already gone?)"
    fi
    # NOTE: telegram flock bot.pid wait removed with the plugin (P2 step ⑤);
    # the daemon is a single long-lived process, not a per-CC flock holder.
    log_ok "ka workshop stop: clean stop"
}

# ============================================================================
# cmd_spawn_mates — registrar.
#   no workdir → alias for `ka workshop start <name>`.
#   with workdir → if the pane is already running: do NOTHING (yaml untouched),
#     just report it (owner must `stop` first to relaunch elsewhere). Otherwise
#     upsert the mate into workshop.yaml (add new default=false, or replace an
#     existing name's cwd) and launch it via a fresh `start <name>` (which
#     re-reads the just-edited yaml).
# ============================================================================
cmd_spawn_mates() {
    if [ -z "$TARGET" ]; then
        log_err "usage: ka workshop spawn-mates <name> [<workdir>]"
        exit 2
    fi
    if [ -z "$WORKDIR_ARG" ]; then
        cmd_start   # no workdir → alias for start <name>
        return $?
    fi

    # expand a leading ~ so the yaml stores an absolute path (yaml-parse does not
    # expand ~, and start-pane's cwd check would fail on a literal ~).
    case "$WORKDIR_ARG" in "~"/*) WORKDIR_ARG="$HOME/${WORKDIR_ARG#"~/"}" ;; esac

    local channel; channel="$(sanitize_channel "$TARGET")"

    # 1. already running → completely untouched (not even the yaml).
    if "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
        local running; running="$(find_pane_by_channel "$channel")"
        if [ -n "$running" ]; then
            log_warn "'$TARGET' is already running (pane $running) — no change made (yaml untouched)."
            log_dim "to relaunch with a new workdir: ka workshop stop $TARGET, then spawn-mates again."
            return 0
        fi
    fi

    # 2. not running → upsert yaml + launch.
    if [ ! -d "$WORKDIR_ARG" ]; then
        log_err "workdir does not exist: $WORKDIR_ARG"
        exit 1
    fi
    local upsert="$KA_WORKSHOP_DIR/yaml-upsert-mate.py"
    if [ "$DRY_RUN" = "1" ]; then
        echo "[dry-run] python3 $upsert $CONFIG $TARGET $WORKDIR_ARG   # add/replace mate (default=false)"
        echo "[dry-run] then: ka workshop start $TARGET   # launch with the edited yaml"
        exit 0
    fi
    if python3 "$upsert" "$CONFIG" "$TARGET" "$WORKDIR_ARG"; then
        log_ok "registered mate '$TARGET' (cwd=$WORKDIR_ARG) in $CONFIG"
    else
        log_err "failed to upsert mate '$TARGET' into $CONFIG"
        exit 1
    fi
    # 3. delegate to a fresh `start <name>` so it re-reads the edited yaml.
    local fwd=(start "$TARGET")
    if [ "$LAYOUT" = "window" ]; then fwd+=(--window); else fwd+=(--pane); fi
    exec bash "$0" "${fwd[@]}"
}

# ============================================================================
# cmd_restart — restart the workshop.
#   no <name> → restart the WHOLE workshop (stop all → start all default mates;
#               absorbs the old top-level `ka restart`). Run from OUTSIDE the
#               session (a plain terminal): stopping the session kills the
#               invoking pane otherwise.
#   <name>    → restart just that one mate's pane (stop it + start <name>).
#   ⚠️ A restart loses that CC's in-memory context (--resume only restores the
#     on-disk transcript). If a channel merely dropped (e.g. after a daemon
#     restart) and you want to keep context, do NOT restart — trigger a tool
#     call in that CC's window to re-init (see telegram-channel-design A5).
# ============================================================================
cmd_restart() {
    if [ -z "$TARGET" ]; then
        # Whole-workshop restart (was the top-level `ka restart`): stop all → start all.
        if [ "$DRY_RUN" = "1" ]; then
            echo "[dry-run] ka workshop stop (whole session) → sleep 2 → start all default mates"
            exit 0
        fi
        log_info "restart: stopping the whole workshop…"
        cmd_stop || log_warn "stop returned non-zero (continuing)"
        sleep 2
        log_info "restart: starting…"
        local fwd=(start)
        if [ "$LAYOUT" = "window" ]; then fwd+=(--window); else fwd+=(--pane); fi
        exec bash "$0" "${fwd[@]}"
    fi
    build_entries          # resolve TARGET → actual channel (main pane→'main'; correct when name≠channel)
    if [ "${#ENTRY_NAMES[@]}" -eq 0 ]; then
        log_err "'$TARGET' is not declared in workshop.yaml (session '$SESSION')"
        exit 1
    fi
    local channel="${ENTRY_CHANNELS[0]}" pane_id=""
    if "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
        pane_id="$(find_pane_by_channel "$channel")"
    fi
    if [ -n "$pane_id" ]; then
        if [ "$DRY_RUN" = "1" ]; then
            echo "[dry-run] stop pane for '$TARGET' (channel $channel), then start $TARGET"
        else
            log_info "restart '$TARGET': stop the existing pane first, then start it"
            cmd_stop            # session+pane confirmed present → take the single-name path to stop it, return 0
            sleep 1
        fi
    else
        log_info "restart '$TARGET': not currently running, starting directly"
    fi
    # Delegate to start <name>, reusing all the launch logic (daemon ensure / yaml / resume).
    local fwd=(start "$TARGET")
    if [ "$LAYOUT" = "window" ]; then fwd+=(--window); else fwd+=(--pane); fi
    [ "$DRY_RUN" = "1" ] && fwd+=(--dry-run)
    exec bash "$0" "${fwd[@]}"
}

# ---- dispatch ---------------------------------------------------------------
case "$VERB" in
    start)       cmd_start ;;
    stop)        cmd_stop ;;
    restart)     cmd_restart ;;
    spawn-mates) cmd_spawn_mates ;;
    *)           log_err "unknown verb: $VERB"; exit 2 ;;
esac
