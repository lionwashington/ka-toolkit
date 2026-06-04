#!/bin/bash
# ka doctor — deeper health + consistency diagnostics with fix hints.
# Read-only: no tmux/daemon/file mutations. Complements `ka status` (which is a
# <1s summary) by checking cross-cutting invariants and printing how to fix.
#
# Exit codes:
#   0  all checks passed
#   1  one or more issues found (warnings or errors)
set -uo pipefail

: "${KA_HOME:=$HOME/.knowledge-assistant}"
source "$KA_HOME/shared/ops/common.sh"
# shellcheck source=../lib/runtimes/dispatch.sh
source "$KA_RUNTIMES_DIR/dispatch.sh"

CONFIG="$(resolve_workshop_config)"
SESSION="$(workshop_session_name "$CONFIG")"
# Channel kind + port = single source of truth: config.yaml channel_kind +
# the active daemon's config.json http_port (resolved in common.sh). Daemon
# dir is <kind>-daemon.
DKIND="$(ka_channel_kind)" || exit 2
_daemon_sub="${DKIND}-daemon"
PORT="$(ka_channel_port)"
issues=0

note_ok()   { printf '  %s %s\n' "$(glyph_ok)" "$*"; }
note_warn() { printf '  %s %s\n' "$(glyph_warn)" "$*"; issues=$((issues + 1)); }
note_err()  { printf '  %s %s\n' "$(glyph_err)" "$*"; issues=$((issues + 1)); }
hint()      { printf '       %s↳ %s%s\n' "$C_DIM" "$*" "$C_RST"; }

echo "── ka doctor ──"

# 1. config present
if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
    note_ok "config: $CONFIG"
else
    note_err "config: no workshop.yaml found"
    hint "create ~/.knowledge-assistant/workshop.yaml (or set OPS_CONFIG)"
fi

# 2. runtime is cc (only implemented adapter)
rt_default="cc"
if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
    rt_default="$(runtime_default_from_config "$CONFIG" 2>/dev/null || echo cc)"
fi
if [ "$rt_default" = "cc" ]; then
    note_ok "runtime: cc"
else
    note_warn "runtime: $rt_default — only 'cc' is implemented (codex/gemini reserved)"
    hint "set 'runtime: cc' in workshop.yaml, or expect adapter-missing warnings"
fi

# 3. channel daemon health (daemon kind = KA_CHANNEL_KIND: lark→9876 / telegram→9877)
if curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
    note_ok "$DKIND daemon: up (port $PORT)"
else
    note_err "$DKIND daemon: down (port $PORT) — channels offline"
    _ds="$KA_HOME/channels/$_daemon_sub/start.sh"
    hint "start: $_ds   (or just run ka workshop, which ensures the daemon is up)"
fi

# 4. workshop session + per-pane invariants
if tmux_has_session "$SESSION" 2>/dev/null; then
    pc="$(tmux_pane_count "$SESSION")"
    note_ok "session: $SESSION ($pc panes)"

    # 4a. channel uniqueness — two panes sharing a channel = cross-talk.
    dupes="$("$TMUX_BIN" list-panes -s -t "$SESSION" -F '#{@ka_channel}' 2>/dev/null \
        | grep -v '^$' | sort | uniq -d)"
    if [ -n "$dupes" ]; then
        note_warn "duplicate channels: $(printf '%s' "$dupes" | tr '\n' ' ')"
        hint "two panes share one channel — stop the extra (ka workshop stop <name>)"
    else
        note_ok "channels unique"
    fi

    # 4b. each pane's cwd exists.
    bad_cwd=0
    while IFS='|' read -r pcwd pch; do
        [ -z "$pcwd" ] && continue
        if [ ! -d "$pcwd" ]; then
            note_warn "pane '${pch:-?}' cwd missing: $pcwd"
            bad_cwd=1
        fi
    done < <("$TMUX_BIN" list-panes -s -t "$SESSION" -F '#{pane_current_path}|#{@ka_channel}' 2>/dev/null)
    [ "$bad_cwd" = 0 ] && note_ok "pane cwds all exist"
else
    note_err "session: $SESSION not running"
    hint "bring the workshop up: ka workshop"
fi

# 5. declared mates (yaml default=true) vs running (tmux panes)
# NB: assign empty () not bare `declare -a` — under `set -u`, referencing
# ${#DECLARED[@]} on a declared-but-unassigned array errors "unbound variable"
# on bash < 4.4 (the case when there are no default mates).
declare -a DECLARED=()
if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
    while IFS= read -r rec; do
        [ -z "$rec" ] && continue
        rec_safe="${rec//$'\t'/$'\x1f'}"
        IFS=$'\x1f' read -r kind a b c d <<<"$rec_safe"
        [ "$kind" = "mate" ] && [ "$d" = "1" ] && DECLARED+=("$a")
    done < <("$KA_WORKSHOP_DIR/yaml-parse.sh" "$CONFIG" 2>/dev/null)
fi
if [ "${#DECLARED[@]}" -gt 0 ] && tmux_has_session "$SESSION" 2>/dev/null; then
    running="$("$TMUX_BIN" list-panes -s -t "$SESSION" -F '#{@ka_channel}' 2>/dev/null | grep -vx main | grep -v '^$')"
    missing=""
    for name in "${DECLARED[@]}"; do
        printf '%s\n' "$running" | grep -qx "$name" || missing="$missing $name"
    done
    if [ -n "$missing" ]; then
        note_warn "declared mates not running:$missing"
        hint "start them: ka workshop start <name>  (or ka workshop to bring all up)"
    else
        note_ok "all ${#DECLARED[@]} default mates running"
    fi
fi

# 6. cron jobs installed (declarative cron.yaml → launchd plists [macOS] / crontab lines [Linux])
# Backend-aware to match detect_backend (Darwin→launchd, else→crontab); the old
# launchd-only check always reported 0 on Linux/WSL even with jobs in crontab.
cron_yaml="$HOME/.knowledge-assistant/cron.yaml"
if [ -f "$cron_yaml" ]; then
    if [ "$(uname)" = "Darwin" ]; then
        installed="$(ls "$HOME"/Library/LaunchAgents/com.knowledge-assistant.ka.cron.*.plist 2>/dev/null | wc -l | tr -d ' ')"
    else
        installed="$(crontab -l 2>/dev/null | grep -c '# ka-cron:')"
    fi
    if [ "$installed" -gt 0 ]; then
        note_ok "cron: $installed job(s) installed (detail: ka cron list)"
    else
        note_warn "cron.yaml exists but no jobs installed"
        hint "install: ka cron install"
    fi
else
    note_ok "cron: no cron.yaml (no scheduled jobs — fine)"
fi

# 7. channels config — capture/inject whitelists (fail-closed) + name resolvability.
# Read through config-cli (the single source); a name is "resolvable" if a running
# workshop pane carries that @ka_channel.
cfgcli="$KA_HOME/kb/core/dist/config-cli.js"
node_bin="$(command -v node || echo /opt/homebrew/bin/node)"
if [ -f "$cfgcli" ] && [ -x "$node_bin" ]; then
    running_ch="$("$TMUX_BIN" list-panes -s -t "$SESSION" -F '#{@ka_channel}' 2>/dev/null | grep -v '^$')"
    check_channel_names() {  # <label> <newline-list>
        local label="$1" list="$2" c
        while IFS= read -r c; do
            [ -n "$c" ] || continue
            printf '%s\n' "$running_ch" | grep -qx "$c" \
                || note_warn "channels.$label: '$c' has no matching pane in the running workshop (name misconfigured?)"
        done <<<"$list"
    }
    cap="$("$node_bin" "$cfgcli" capture 2>/dev/null)"
    inj="$("$node_bin" "$cfgcli" inject 2>/dev/null)"
    if [ -z "$cap" ]; then
        note_warn "channels.capture not configured → no conversations are being captured"
        hint "to capture: set channels.capture: [main] in ~/.knowledge-assistant/config.yaml"
    else
        note_ok "channels.capture: $(echo $cap | tr '\n' ' ')"
        check_channel_names capture "$cap"
    fi
    if [ -z "$inj" ]; then
        note_warn "channels.inject not configured → scheduled distill/daily-brief won't inject"
        hint "to inject: set channels.inject: [main] in config.yaml"
    else
        note_ok "channels.inject: $(echo $inj | tr '\n' ' ')"
        check_channel_names inject "$inj"
    fi
else
    note_warn "channels: config-cli not found (core-cli not deployed?) — skipping check"
fi

echo ""
if [ "$issues" -eq 0 ]; then
    printf '%s doctor: ✅ all checks passed%s\n' "$C_GRN" "$C_RST"
    _exit=0
else
    printf '%s doctor: ⚠️  %s issue(s) found%s\n' "$C_YEL" "$issues" "$C_RST"
    _exit=1
fi

# ──────────────────────────────────────────────────────────────────────────
# CONFIG DETAIL (informational — does NOT affect issue count / exit code).
# These sections describe the *declared* config, complementing the pass/fail
# checks above. `ka status` shows the runtime state; doctor shows the config.
# ──────────────────────────────────────────────────────────────────────────

# a. workshop config — session name, panes (name/cwd/main), mates (name/cwd/default)
echo ""
printf '%s── workshop config ──%s\n' "$C_DIM" "$C_RST"
if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
    printf '  session: %s\n' "$SESSION"
    printf '  runtime: %s\n' "$rt_default"

    # panes
    have_pane=0
    while IFS= read -r rec; do
        [ -z "$rec" ] && continue
        rec_safe="${rec//$'\t'/$'\x1f'}"
        IFS=$'\x1f' read -r kind a b c _ <<<"$rec_safe"
        [ "$kind" = "pane" ] || continue
        if [ "$have_pane" = 0 ]; then
            printf '  panes:\n'
            printf '    %-14s %-4s %s\n' "NAME" "MAIN" "CWD"
            have_pane=1
        fi
        mflag="no"; [ "$c" = "1" ] && mflag="yes"
        printf '    %-14s %-4s %s\n' "$a" "$mflag" "$b"
    done < <("$KA_WORKSHOP_DIR/yaml-parse.sh" "$CONFIG" 2>/dev/null)
    [ "$have_pane" = 0 ] && printf '  panes:  (none declared)\n'

    # mates
    have_mate=0
    while IFS= read -r rec; do
        [ -z "$rec" ] && continue
        rec_safe="${rec//$'\t'/$'\x1f'}"
        IFS=$'\x1f' read -r kind a b _ d <<<"$rec_safe"
        [ "$kind" = "mate" ] || continue
        if [ "$have_mate" = 0 ]; then
            printf '  mates:\n'
            printf '    %-16s %-8s %s\n' "NAME" "DEFAULT" "CWD"
            have_mate=1
        fi
        dflag="no"; [ "$d" = "1" ] && dflag="yes"
        printf '    %-16s %-8s %s\n' "$a" "$dflag" "$b"
    done < <("$KA_WORKSHOP_DIR/yaml-parse.sh" "$CONFIG" 2>/dev/null)
    [ "$have_mate" = 0 ] && printf '  mates:  (none declared)\n'
else
    printf '  %s(no workshop.yaml — nothing to show)%s\n' "$C_DIM" "$C_RST"
fi

# d. hooks — settings.json hook events → command paths, runtime vs repo origin
echo ""
printf '%s── hooks (settings.json) ──%s\n' "$C_DIM" "$C_RST"
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ] && command -v python3 >/dev/null 2>&1; then
    runtime_hooks_dir="$KA_HOME/kb/hooks"
    hook_rows="$(python3 - "$SETTINGS" "$runtime_hooks_dir" "$KA_HOME" <<'PY' 2>/dev/null
import json, sys
settings, rt_dir, repo = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(settings) as f:
        hooks = json.load(f).get("hooks", {})
except Exception:
    sys.exit(0)
rows = []
for event in sorted(hooks):
    for group in hooks[event]:
        for h in group.get("hooks", []):
            cmd = h.get("command", "")
            if rt_dir in cmd:
                origin = "runtime"
            elif repo and repo in cmd:
                origin = "repo"
            else:
                origin = "other"
            rows.append(f"{event}\t{origin}\t{cmd}")
print("\n".join(rows))
PY
)"
    if [ -n "$hook_rows" ]; then
        printf '    %-14s %-8s %s\n' "EVENT" "ORIGIN" "COMMAND"
        repo_warned=0
        while IFS=$'\t' read -r ev origin cmd; do
            [ -z "$ev" ] && continue
            printf '    %-14s %-8s %s\n' "$ev" "$origin" "$cmd"
            [ "$origin" = "repo" ] && repo_warned=1
        done <<<"$hook_rows"
        if [ "$repo_warned" = 1 ]; then
            printf '    %s↳ a hook points at the repo, not runtime/ — run ./install.sh to deploy%s\n' "$C_DIM" "$C_RST"
        fi
    else
        printf '  (no hooks configured in settings.json)\n'
    fi
else
    printf '  %s(settings.json or python3 unavailable)%s\n' "$C_DIM" "$C_RST"
fi

exit "$_exit"
