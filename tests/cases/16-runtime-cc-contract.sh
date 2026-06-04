#!/bin/bash
# 16-runtime-cc-contract — adapter contract tests.
#
# P2: the team-related verbs (spawn_mate_prompt_template, list_registered_mates,
# describe_registered_mates, settings_path, telegram_status) retired together
# with the CC team mechanism. This tests the remaining adapter contract.
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
export KA_HOME="$REPO"
OPS="$REPO/workshop/ops"
DISPATCH="$OPS/runtimes/dispatch.sh"
[ -f "$DISPATCH" ] || { echo "FAIL: $DISPATCH missing"; exit 1; }
# shellcheck disable=SC1090
source "$DISPATCH"
runtime_load "cc" || { echo "FAIL: runtime_load cc failed"; exit 1; }

fail() { echo "FAIL: $*"; exit 1; }
ok()   { echo "  ok: $*"; }

# -- 1. Required functions are defined ---------------------------------------
REQUIRED="
runtime::ready_match
runtime::inject_prompt
runtime::launch_pane_script
runtime::launch_binary
"
for fn in $REQUIRED; do
    runtime_has "$fn" || fail "missing function: $fn"
done
ok "all 4 adapter functions defined"

# -- 2. ready_match: caret / bar / status positive ---------------------------
caret_fixture=$'───────────────────\n    ❯    \n───────────────────\n ? ctrl+t to show tasks'
tag="$(runtime::ready_match "$caret_fixture")" || fail "ready_match rejected caret fixture"
case "$tag" in *prompt-caret*) ok "ready_match caret → $tag" ;; *) fail "caret tag: $tag" ;; esac

bar_fixture=$'╭─────────╮\n│ >       │\n╰─────────╯'
tag="$(runtime::ready_match "$bar_fixture")" || fail "ready_match rejected bar fixture"
case "$tag" in *prompt-bar*) ok "ready_match bar → $tag" ;; *) fail "bar tag: $tag" ;; esac

status_only=$'some spinner\n ? shift+tab to expand'
tag="$(runtime::ready_match "$status_only")" || fail "ready_match rejected status fixture"
case "$tag" in *status*) ok "ready_match status → $tag" ;; *) fail "status tag: $tag" ;; esac

# -- 3. ready_match: negative on boot screen ---------------------------------
negative=$'Resuming session…\nLoading MCP servers…'
if runtime::ready_match "$negative" >/dev/null; then fail "ready_match accepted boot screen"; fi
ok "ready_match rejects boot screen"

# -- 4. launch_binary is 'claude' --------------------------------------------
bin="$(runtime::launch_binary)"
[ "$bin" = "claude" ] || fail "launch_binary expected 'claude', got '$bin'"
ok "launch_binary → claude"

# -- 5. launch_pane_script resolves to an existing file ----------------------
lps="$(runtime::launch_pane_script)"
[ -f "$lps" ] || fail "launch_pane_script path does not exist: $lps"
ok "launch_pane_script → $lps"

# -- 6. runtime_load rejects unknown runtimes --------------------------------
if runtime_load "gemini" 2>/dev/null; then fail "runtime_load should refuse gemini in phase 2"; fi
ok "runtime_load refuses phase-3 runtimes"

# -- 7. runtime_default_from_config handles missing key ----------------------
tmp_cfg="$(mktemp)"
cat > "$tmp_cfg" <<'YAML'
session: demo
mates:
  - name: team-lead
    cwd: /tmp
    main: true
YAML
rt="$(runtime_default_from_config "$tmp_cfg")"
[ "$rt" = "cc" ] || fail "default runtime should be 'cc' when omitted, got '$rt'"
rm -f "$tmp_cfg"
ok "runtime_default_from_config defaults to cc"

# -- 8. main-pane / mate runtime override round-trip via yaml-parse ----------
# Under the merged schema, only `main: true` entries are panes; every other
# entry (gem, mater) is a mate, so both carry a mate_runtime override.
tmp_cfg="$(mktemp)"
cat > "$tmp_cfg" <<'YAML'
session: demo
runtime: cc
mates:
  - name: team-lead
    cwd: /tmp
    main: true
  - name: gem
    cwd: /tmp
    runtime: gemini
  - name: mater
    cwd: /tmp
    runtime: codex
YAML
out="$("$OPS/yaml-parse.sh" "$tmp_cfg")"
printf '%s\n' "$out" | grep -qx $'runtime_default\tcc'         || fail "missing runtime_default record"
printf '%s\n' "$out" | grep -qx $'mate_runtime\tgem\tgemini'   || fail "missing mate_runtime gem record"
printf '%s\n' "$out" | grep -qx $'mate_runtime\tmater\tcodex'  || fail "missing mate_runtime mater record"
rm -f "$tmp_cfg"
ok "yaml-parse emits runtime_default / mate_runtime for non-main entries"

echo "PASS: 16-runtime-cc-contract"
exit 0
