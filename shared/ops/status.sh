#!/bin/bash
# ka status — <1s health summary. No side effects, no exit on missing things.
#
# Exit codes:
#   0  healthy
#   1  degraded (something is wrong but workshop runs)
#   2  broken   (workshop session not running at all)
set -euo pipefail

: "${KA_HOME:=$HOME/.knowledge-assistant}"
source "$KA_HOME/shared/ops/common.sh"
# shellcheck source=../lib/runtimes/dispatch.sh
source "$KA_RUNTIMES_DIR/dispatch.sh"

CONFIG="$(resolve_workshop_config)"
SESSION="$(workshop_session_name "$CONFIG")"

degraded=0
broken=0

echo "── ka status ──"

# Config
if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
    printf '  %s config:    %s\n' "$(glyph_ok)" "$CONFIG"
else
    printf '  %s config:    (no workshop.yaml found)\n' "$(glyph_err)"
    degraded=1
fi

# runtime (phase-1 informational: field recognized, all adapters not yet split)
runtime_default="cc"
if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
    while IFS= read -r rec; do
        [ -z "$rec" ] && continue
        IFS=$'\t' read -r kind a _ <<<"$rec"
        if [ "$kind" = "runtime_default" ]; then
            runtime_default="$a"
            break
        fi
    done < <("$KA_WORKSHOP_DIR/yaml-parse.sh" "$CONFIG" 2>/dev/null)
fi
if runtime_load "$runtime_default" 2>/dev/null; then
    printf '  %s runtime:   %s\n' "$(glyph_ok)" "$runtime_default"
else
    # Field recognized but adapter not yet implemented. Warn, but do NOT
    # change exit code — status must not break when future runtimes appear.
    printf '  %s runtime:   %s (no adapter; see docs/KA_CLI_RUNTIME_DESIGN.md)\n' \
        "$(glyph_warn)" "$runtime_default"
fi

# tmux session
if tmux_has_session "$SESSION" 2>/dev/null; then
    pane_count="$(tmux_pane_count "$SESSION")"
    printf '  %s session:   %s (%s panes)\n' "$(glyph_ok)" "$SESSION" "$pane_count"
else
    printf '  %s session:   %s (not running)\n' "$(glyph_err)" "$SESSION"
    broken=1
fi

# mate list: compare declared (workshop.yaml) vs registered (via adapter)
DECLARED_NAMES=()
if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
    while IFS= read -r rec; do
        [ -z "$rec" ] && continue
        IFS=$'\t' read -r kind a b c d <<<"$rec"
        if [ "$kind" = "mate" ] && [ "$d" = "1" ]; then
            DECLARED_NAMES+=("$a")
        fi
    done < <("$KA_WORKSHOP_DIR/yaml-parse.sh" "$CONFIG" 2>/dev/null)
fi
declared_n="${#DECLARED_NAMES[@]}"

# Running agents = all CC panes tagged with @ka_channel (P2: no CC team registry
# anymore; an agent is just a tmux pane). INCLUDES the main pane — main is the lead
# (one of the agents), so the count reflects every running CC, not just non-lead mates.
running_names=""
if tmux_has_session "$SESSION" 2>/dev/null; then
    running_names="$("$TMUX_BIN" list-panes -s -t "$SESSION" -F '#{@ka_channel}' 2>/dev/null \
        | grep -v '^$' | sort -u)"
fi
if [ -n "$running_names" ]; then
    mate_count="$(printf '%s\n' "$running_names" | grep -c .)"
    printf '  %s mates:     %s running (incl. main)\n' "$(glyph_ok)" "$mate_count"
    # List the lead (main) first with a (lead) marker, then the rest in order.
    if printf '%s\n' "$running_names" | grep -qx main; then
        printf '             - %-13s(lead)\n' "main"
    fi
    printf '%s\n' "$running_names" | grep -vx main | sed 's/^/             - /'
    # Flag declared-but-not-running mates.
    if [ "$declared_n" -gt 0 ]; then
        missing=""
        for name in "${DECLARED_NAMES[@]}"; do
            printf '%s\n' "$running_names" | grep -qx "$name" || missing="$missing $name"
        done
        if [ -n "$missing" ]; then
            printf '             %s not running:%s (run: ka workshop start <name>)\n' "$(glyph_warn)" "$missing"
            degraded=1
        fi
    fi
else
    printf '  %s mates:     none running' "$(glyph_warn)"
    [ "$declared_n" -gt 0 ] && printf ' (%s declared — run: ka workshop)' "$declared_n"
    printf '\n'
    [ "$declared_n" -gt 0 ] && degraded=1
fi

# channel daemon health. Kind + port come from config.yaml channel_kind +
# channels.<kind>.port (resolved in common.sh) — telegram→9877 / lark→9876.
_dkind="$(ka_channel_kind)" || _dkind="telegram"
_dport="$(ka_channel_port)"
_daemon_json=""
if _daemon_json="$(curl -sf --max-time 1 "http://127.0.0.1:$_dport/api/status" 2>/dev/null)"; then
    printf '  %s %s:  daemon up (port %s)\n' "$(glyph_ok)" "$_dkind" "$_dport"
else
    printf '  %s %s:  daemon down (port %s — channels offline)\n' "$(glyph_warn)" "$_dkind" "$_dport"
    _daemon_json=""
    degraded=1
fi

# kb retrieval daemon health — the 2nd resident daemon (LanceDB kb_search backend,
# port from retrieval.daemon.port, default 7705). Same HTTP-probe shape as the
# channel daemon, plus a warm/ready distinction. (Only liveness/readiness is shown;
# the daemon's knowledge_base_path is intentionally NOT printed.)
_kbport="$(ka_kb_retrieval_port)"
if _kb_json="$(curl -sf --max-time 1 "http://127.0.0.1:$_kbport/api/status" 2>/dev/null)"; then
    _kb_ready="$(printf '%s' "$_kb_json" | sed -n 's/.*"ready":[[:space:]]*\([a-z]*\).*/\1/p')"
    _kb_pid="$(printf '%s' "$_kb_json" | sed -n 's/.*"pid":[[:space:]]*\([0-9]*\).*/\1/p')"
    if [ "$_kb_ready" = "true" ]; then
        printf '  %s kb:        daemon up (port %s, pid %s, ready)\n' "$(glyph_ok)" "$_kbport" "${_kb_pid:-?}"
    else
        printf '  %s kb:        daemon up (port %s, pid %s — WARMING, not ready)\n' "$(glyph_warn)" "$_kbport" "${_kb_pid:-?}"
    fi
else
    printf '  %s kb:        daemon down (port %s — kb_search offline)\n' "$(glyph_warn)" "$_kbport"
    degraded=1
fi

# ──────────────────────────────────────────────────────────────────────────
# RUNTIME-STATE DETAIL (informational — does not change broken/degraded above
# unless a hard failure is detected). Each section degrades gracefully.
# ──────────────────────────────────────────────────────────────────────────

# b. workshop runtime: per-pane channel / cwd / alive
echo ""
printf '%s── workshop panes ──%s\n' "$C_DIM" "$C_RST"
if tmux_has_session "$SESSION" 2>/dev/null; then
    printf '    %-14s %-6s %s\n' "CHANNEL" "CWD?" "CWD"
    while IFS='|' read -r pch pcwd; do
        [ -z "$pch" ] && [ -z "$pcwd" ] && continue
        alive="ok"
        if [ -z "$pcwd" ] || [ ! -d "$pcwd" ]; then alive="MISSING"; fi
        printf '    %-14s %-6s %s\n' "${pch:-?}" "$alive" "${pcwd:-?}"
    done < <("$TMUX_BIN" list-panes -s -t "$SESSION" -F '#{@ka_channel}|#{pane_current_path}' 2>/dev/null)
else
    printf '  %s(session not running)%s\n' "$C_DIM" "$C_RST"
fi

# c. channel daemon: channels_online + per-channel session count + key counters + uptime
echo ""
printf '%s── channel daemon ──%s\n' "$C_DIM" "$C_RST"
if [ -n "$_daemon_json" ] && command -v python3 >/dev/null 2>&1; then
    KA_DAEMON_JSON="$_daemon_json" python3 - <<'PY' 2>/dev/null || printf '  (could not parse daemon status)\n'
import json, os, sys
try:
    d = json.loads(os.environ.get("KA_DAEMON_JSON", ""))
except Exception:
    sys.exit(1)
up = d.get("uptime_seconds", 0) or 0
h, rem = divmod(int(up), 3600); m = rem // 60
co = d.get("channels_online", {}) or {}
alive = d.get("channel_alive", {}) or {}
nums = d.get("channel_numbers", {}) or {}
print(f"    uptime:     {h}h{m:02d}m   pid {d.get('pid','?')}")
print(f"    channels:   {len(co)} online")
if co:
    print(f"    {'CHANNEL':<14} {'#':<4} {'SESS':<5} ALIVE")
    for name in sorted(co):
        a = "ok" if alive.get(name) else "HALF-OPEN"
        print(f"    {name:<14} {str(nums.get(name,'?')):<4} {str(co[name]):<5} {a}")
def g(k): return d.get(k, 0)
print(f"    dispatches={g('dispatches_total')} replies={g('replies_total')} "
      f"route_miss={g('route_miss_total')}")
print(f"    probes_sent={g('probes_sent_total')} probe_fail={g('probe_failures_total')} "
      f"reconnects={g('probe_reconnect_triggered_total')}")
PY
else
    printf '  %s(daemon down — no runtime counters)%s\n' "$C_DIM" "$C_RST"
fi

# d. kb daemon: liveness / readiness / session count / uptime (the 2nd resident
# daemon; reuses _kb_json fetched above). knowledge_base_path is intentionally NOT shown.
echo ""
printf '%s── kb daemon ──%s\n' "$C_DIM" "$C_RST"
if [ -n "$_kb_json" ] && command -v python3 >/dev/null 2>&1; then
    KA_KB_JSON="$_kb_json" python3 - <<'PY' 2>/dev/null || printf '  (could not parse kb status)\n'
import json, os, sys
try:
    d = json.loads(os.environ.get("KA_KB_JSON", ""))
except Exception:
    sys.exit(1)
up = d.get("uptime_seconds", 0) or 0
h, rem = divmod(int(up), 3600); m = rem // 60
ready = d.get("ready")
print(f"    uptime:     {h}h{m:02d}m   pid {d.get('pid','?')}")
print(f"    engine:     {d.get('engine','?')}   ready: {'yes' if ready else 'no (warming)'}")
print(f"    sessions:   {d.get('mcp_sessions','?')} mcp (raw, incl. not-yet-reaped)")
we = d.get("warm_error")
if we:
    print(f"    warm_error: {we}")
PY
    # Per-pane real connections: the daemon's mcp_sessions is anonymous + zombie-inflated, so
    # resolve who's actually connected by mapping each kb client socket's cwd → pane @ka_channel
    # (same technique as `ka doctor` kb-coverage). Shows MISSING for a pane that lost kb.
    if command -v lsof >/dev/null 2>&1 && tmux_has_session "$SESSION" 2>/dev/null; then
        _kb_conn=""
        for _pid in $(lsof -nP -iTCP:"$_kbport" 2>/dev/null | grep ESTABLISHED | grep -v "$_kbport->" | awk '{print $2}' | sort -u); do
            _cwd="$(lsof -a -p "$_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
            [ -n "$_cwd" ] || continue
            _pch="$("$TMUX_BIN" list-panes -s -t "$SESSION" -F '#{pane_current_path}|#{@ka_channel}' 2>/dev/null \
                | awk -F'|' -v c="$_cwd" '$1==c{print $2; exit}')"
            [ -n "$_pch" ] && _kb_conn="$_kb_conn $_pch"
        done
        printf '    %-14s %s\n' "CHANNEL" "KB"
        "$TMUX_BIN" list-panes -s -t "$SESSION" -F '#{@ka_channel}' 2>/dev/null | grep -v '^$' | sort -u | while IFS= read -r _p; do
            if printf '%s\n' $_kb_conn | grep -qx "$_p"; then _st="ok"; else _st="MISSING"; fi
            printf '    %-14s %s\n' "$_p" "$_st"
        done
    fi
else
    printf '  %s(kb daemon down — no runtime detail)%s\n' "$C_DIM" "$C_RST"
fi

# e. distill: last run verdict + time + last-run stats
echo ""
printf '%s── distill ──%s\n' "$C_DIM" "$C_RST"
_distill_file="$KA_STATE_DIR/distill-current.json"
if [ -f "$_distill_file" ] && command -v node >/dev/null 2>&1; then
    node -e '
      const fs=require("fs");
      let j; try{ j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }catch{ process.exit(1); }
      const alive=(p)=>{ if(!p) return false; try{ process.kill(p,0); return true; }catch{ return false; } };
      let verdict = j.status==="running" ? (alive(j.pid)?"running":"running-but-pid-dead") : (j.status||"unknown");
      console.log("    verdict:    "+verdict);
      console.log("    last run:   "+(j.end_time||j.start_time||"(none)"));
      console.log("    last batch: snapshots="+(j.snapshot_count??"?")+" raw_added="+(j.raw_added??"?")
                  +" conv_updated="+(j.conversations_updated??"?")+" topics="+(j.topics_updated??"?"));
      console.log("    offset:     "+(j.snapshot_offset??"?")+"   (true unprocessed count computed at next run)");
    ' "$_distill_file" 2>/dev/null || printf '  (could not parse distill state)\n'
else
    printf '  %s(no distill run recorded yet)%s\n' "$C_DIM" "$C_RST"
fi

# f. cron: each job schedule + last-run + status
echo ""
printf '%s── cron ──%s\n' "$C_DIM" "$C_RST"
_cron_list="$KA_CRON_CMD_DIR/list.sh"
if [ -x "$_cron_list" ]; then
    "$_cron_list" 2>/dev/null | sed 's/^/    /'
else
    printf '  %s(cron list unavailable)%s\n' "$C_DIM" "$C_RST"
fi

echo ""
if [ "$broken" -eq 1 ]; then
    printf '%s overall: ❌ broken%s (session down; run: ka workshop)\n' "$C_RED" "$C_RST"
    exit 2
elif [ "$degraded" -eq 1 ]; then
    printf '%s overall: ⚠️  degraded%s (workshop runs but some checks failed)\n' "$C_YEL" "$C_RST"
    exit 1
else
    printf '%s overall: ✅ healthy%s\n' "$C_GRN" "$C_RST"
    exit 0
fi
