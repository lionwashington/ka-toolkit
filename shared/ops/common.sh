#!/bin/bash
# shared/ops/common.sh — shared helpers sourced by every ka subcommand.
# Bash 3.2 compatible (macOS default).

# ── location anchor + directory map (single source of truth for code paths) ─────
# Every ka script resolves sibling scripts/dirs from KA_ROOT, never from its
# own location, so a script keeps working no matter where it (or common.sh) is
# moved. KA_ROOT is exported by bin/ka; a standalone run (e.g. the test
# suite) finds it by walking up to the dir that contains the .ka-root marker
# (a marker, so the bootstrap is independent of where bin/ka itself lives).
# shellcheck disable=SC2034
if [ -z "${KA_ROOT:-}" ]; then
    _ka_d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    while [ "$_ka_d" != / ] && [ ! -e "$_ka_d/.ka-root" ]; do _ka_d="$(dirname "$_ka_d")"; done
    KA_ROOT="$_ka_d"
    unset _ka_d
fi
export KA_ROOT

# Code-location map — a strict two-level tree rooted at KA_ROOT. The repo
# (and the runtime that mirrors it) is organized by the four functional parts;
# when the layout changes, edit ONLY these lines. The whole script tree
# references these vars, never relative paths. Exported so a child process (an
# exec'd helper) inherits the map without re-sourcing.
#   level 1 — the parts (each = $KA_ROOT/<part>/ops; plus the config dir)
KA_SHARED_DIR="$KA_ROOT/shared/ops"            # common/doctor/status/help
KA_WORKSHOP_DIR="$KA_ROOT/workshop/ops"        # workshop.sh/wait-ready + start-pane/tmux-helpers/yaml-parse/inject-prompt/upsert
KA_CHANNELS_DIR="$KA_ROOT/channels/ops"        # daemon.sh
KA_CRON_OPS_DIR="$KA_ROOT/cron/ops"            # cron.sh + cron-run.sh + maintenance/
KA_KB_DIR="$KA_ROOT/kb/ops"                    # distill-bg/status/worker
KA_CONFIG_DIR="$KA_ROOT/config"                # bundled config templates
#   level 2 — sub-dirs of a part (each derives from its level-1 parent above)
KA_RUNTIMES_DIR="$KA_WORKSHOP_DIR/runtimes"         # runtime adapters (cc/…)
KA_PANES_DIR="$KA_WORKSHOP_DIR/panes"               # per-pane *.env
KA_CRON_CMD_DIR="$KA_CRON_OPS_DIR/cmd"              # cron subcommands (+ _common.sh, install.sh)
KA_CRON_INTERNALS_DIR="$KA_CRON_OPS_DIR/internals"  # parse-yaml/schedule-parser/plist-gen/backend-adapter
export KA_SHARED_DIR KA_WORKSHOP_DIR KA_CHANNELS_DIR KA_CRON_OPS_DIR KA_KB_DIR KA_CONFIG_DIR
export KA_RUNTIMES_DIR KA_PANES_DIR KA_CRON_CMD_DIR KA_CRON_INTERNALS_DIR

# Colors (disabled when stdout is not a TTY or NO_COLOR is set).
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_GRN=$'\033[32m'
    C_BLU=$'\033[34m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
    C_RED=""; C_YEL=""; C_GRN=""; C_BLU=""; C_DIM=""; C_RST=""
fi

log_info() { printf '%s[ka]%s %s\n' "$C_BLU" "$C_RST" "$*" >&2; }
log_warn() { printf '%s[ka]%s %s%s%s\n' "$C_BLU" "$C_RST" "$C_YEL" "$*" "$C_RST" >&2; }
log_err()  { printf '%s[ka]%s %s%s%s\n' "$C_BLU" "$C_RST" "$C_RED" "$*" "$C_RST" >&2; }
log_ok()   { printf '%s[ka]%s %s%s%s\n' "$C_BLU" "$C_RST" "$C_GRN" "$*" "$C_RST" >&2; }
log_dim()  { printf '%s[ka]%s %s%s%s\n' "$C_BLU" "$C_RST" "$C_DIM" "$*" "$C_RST" >&2; }

# Status glyphs (stdout, not stderr — they're part of the report).
glyph_ok()    { printf '%s✔%s' "$C_GRN" "$C_RST"; }
glyph_warn()  { printf '%s⚠%s' "$C_YEL" "$C_RST"; }
glyph_err()   { printf '%s✖%s' "$C_RED" "$C_RST"; }

TMUX_BIN="${TMUX_BIN:-$(command -v tmux 2>/dev/null || echo /opt/homebrew/bin/tmux)}"

tmux_has_session() {
    local name="$1"
    "$TMUX_BIN" has-session -t "$name" 2>/dev/null
}

tmux_pane_count() {
    local name="$1"
    "$TMUX_BIN" list-panes -t "$name" -a -F '#S' 2>/dev/null \
        | awk -v n="$name" '$1==n' | wc -l | tr -d ' '
}

# Resolve the workshop config path using the same precedence bootstrap.sh uses.
resolve_workshop_config() {
    if [ -n "${OPS_CONFIG:-}" ] && [ -f "$OPS_CONFIG" ]; then
        printf '%s' "$OPS_CONFIG"; return 0
    fi
    local user_cfg="$HOME/.knowledge-assistant/workshop.yaml"
    if [ -f "$user_cfg" ]; then
        printf '%s' "$user_cfg"; return 0
    fi
    local tmpl="$KA_CONFIG_DIR/workshop.example.yaml"
    [ -f "$tmpl" ] && printf '%s' "$tmpl"
    return 0
}

# Parse session name out of the workshop config via lib/yaml-parse.sh.
workshop_session_name() {
    local cfg="$1"
    [ -f "$cfg" ] || { printf 'workshop'; return; }
    local s
    s="$("$KA_WORKSHOP_DIR/yaml-parse.sh" "$cfg" 2>/dev/null \
         | awk -F'\t' '$1=="session"{print $2; exit}')"
    [ -n "$s" ] && printf '%s' "$s" || printf 'workshop'
}

# ── channel daemon resolution (single source of truth) ──────────────────────
# Which channel daemon is active comes ONLY from config.yaml `channel_kind`
# (telegram | lark; default telegram). The port comes ONLY from the active
# daemon's own config.json `http_port`. No runtime env knobs — config.yaml +
# the daemon's config.json are the two sources, each for its own concern.

# ka_channel_kind → telegram | lark (default telegram). Invalid value =
# fail-closed: error to stderr + return 2 (empty stdout), no silent default.
ka_channel_kind() {
    local cfg kind v
    cfg="${KA_CONFIG:-$HOME/.knowledge-assistant/config.yaml}"
    kind="telegram"
    if [ -f "$cfg" ]; then
        v="$(sed -n 's/^[[:space:]]*channel_kind[[:space:]]*:[[:space:]]*//p' "$cfg" | head -1 | sed 's/[[:space:]]*$//')"
        v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
        [ -n "$v" ] && kind="$v"
    fi
    case "$kind" in
        telegram|lark) printf '%s' "$kind" ;;
        *) log_err "config channel_kind='$kind' is invalid (expected telegram|lark)"; return 2 ;;
    esac
}

# ka_daemon_dir → runtime dir of the active daemon: <kind>-daemon. Prefers the
# repo/runtime-layout sibling of ops/ (KA_ROOT), else ~/.knowledge-assistant/runtime.
ka_daemon_dir() {
    local kind sub
    kind="$(ka_channel_kind)" || return 2
    sub="${kind}-daemon"
    if [ -d "$KA_ROOT/$sub" ]; then
        printf '%s' "$KA_ROOT/$sub"
    else
        printf '%s' "$HOME/.knowledge-assistant/runtime/$sub"
    fi
}

# ka_channel_port → the port the active daemon binds, read from its config.json
# `http_port`. Falls back to the kind default (telegram 9877 / lark 9876) only
# when config.json is absent (e.g. before first deploy).
ka_channel_port() {
    local kind dir cfgjson port
    kind="$(ka_channel_kind)" || return 2
    dir="$(ka_daemon_dir)"
    cfgjson="$dir/config.json"
    port=""
    if [ -f "$cfgjson" ]; then
        port="$(sed -n 's/.*"http_port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$cfgjson" | head -1)"
    fi
    if [ -z "$port" ]; then
        if [ "$kind" = "lark" ]; then port=9876; else port=9877; fi
    fi
    printf '%s' "$port"
}
