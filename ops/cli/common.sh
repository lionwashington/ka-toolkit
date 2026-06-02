#!/bin/bash
# ops/cli/common.sh — shared helpers sourced by every ka subcommand.
# Bash 3.2 compatible (macOS default).

# shellcheck disable=SC2034
KA_REPO_ROOT="${KA_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
OPS_DIR="$KA_REPO_ROOT/ops"
CLI_DIR="$OPS_DIR/cli"

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
    local tmpl="$OPS_DIR/workshop.example.yaml"
    [ -f "$tmpl" ] && printf '%s' "$tmpl"
    return 0
}

# Parse session name out of the workshop config via lib/yaml-parse.sh.
workshop_session_name() {
    local cfg="$1"
    [ -f "$cfg" ] || { printf 'workshop'; return; }
    local s
    s="$("$OPS_DIR/lib/yaml-parse.sh" "$cfg" 2>/dev/null \
         | awk -F'\t' '$1=="session"{print $2; exit}')"
    [ -n "$s" ] && printf '%s' "$s" || printf 'workshop'
}
