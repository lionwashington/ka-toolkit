#!/bin/bash
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
export KA_HOME="$REPO"
export KA_RUNTIMES_DIR="$REPO/workshop/ops/runtimes"
OPS="$REPO/workshop/ops"
source "$OPS/runtimes/dispatch.sh"

fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "  ok: $*"; }

runtime_load codex || fail "runtime_load codex failed"
for fn in runtime::ready_match runtime::inject_prompt runtime::launch_pane_script runtime::launch_binary; do
    runtime_has "$fn" || fail "missing function: $fn"
done
[ "$(runtime::launch_binary)" = codex ] || fail "launch binary is not codex"
[ -x "$(runtime::launch_pane_script)" ] || fail "pane entrypoint is not executable"
ok "Codex adapter contract is complete"

grep -q -- '--dangerously-bypass-approvals-and-sandbox' "$REPO/kb/ops/distill-runtimes/codex.sh" \
    || fail "Codex distill cannot write configured KB paths outside the workshop cwd"
if grep -q -- '--sandbox workspace-write' "$REPO/kb/ops/distill-runtimes/codex.sh"; then
    fail "Codex distill still restricts writes to the workshop cwd"
fi
ok "Codex distill can write the configured KB and worker stats paths"

grep -q -- '--memory-dir "${KNOWLEDGE_BASE_PATH:-$WORKSPACE_CWD/memory}"' "$REPO/kb/ops/distill-bg-worker.sh" \
    || fail "distill result parser still assumes the KB is under the workshop cwd"
grep -q -- 'local rawdir="${KNOWLEDGE_BASE_PATH:-$WORKSPACE_CWD/memory}/raw"' "$REPO/kb/ops/distill-bg-worker.sh" \
    || fail "distill chunk watermark still assumes the KB is under the workshop cwd"
ok "Codex distill state and chunk watermarks use the configured KB path"
if grep -q "thread/fork" "$OPS/runtimes/codex/select-thread.mjs"; then
    fail "implicit Codex thread selection must not fork the latest thread"
fi
grep -q "thread/resume" "$OPS/runtimes/codex/select-thread.mjs" \
    || fail "Codex thread selector does not resume the selected thread"
ok "Codex implicit selection resumes the existing latest cwd thread"

tag="$(runtime::ready_match $'header\n  ›  \n? for shortcuts')" || fail "ready fixture rejected"
case "$tag" in prompt-chevron|status) ;; *) fail "unexpected ready tag: $tag" ;; esac
if runtime::ready_match 'Starting Codex...' >/dev/null; then fail "boot screen accepted"; fi
ok "Codex ready detection accepts idle TUI only"

tmp_root="$(mktemp -d)"
mkdir -p "$tmp_root/bin" "$tmp_root/work"
export KA_STATE_DIR="$tmp_root/state"
cat > "$tmp_root/bin/codex" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$FAKE_CODEX_CALLS"
if printf '%s\n' "$*" | grep -q 'app-server --listen'; then
    for endpoint in "$@"; do :; done
    port="${endpoint##*:}"
    exec python3 -c 'import socket,sys,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(); time.sleep(30)' "$port"
fi
printf '%s\n' "$*" | grep -q 'resume --last' && exit 2
exit 0
SH
chmod +x "$tmp_root/bin/codex"
cat > "$tmp_root/select-thread.mjs" <<'JS'
const cwd = process.argv[3]
const requested = process.argv[4]
process.stdout.write(JSON.stringify({ id: requested || 'thread-current-cwd', path: '/tmp/thread.jsonl', cwd }))
JS
export KA_CODEX_THREAD_SELECTOR="$tmp_root/select-thread.mjs"
export KA_CODEX_KEEP_APP_SERVER_ON_TUI_EXIT=0

FAKE_CODEX_CALLS="$tmp_root/calls" PATH="$tmp_root/bin:$PATH" KA_HOME="$REPO" KA_CHANNEL=main \
    "$OPS/start-pane.sh" codex reviewer "$tmp_root/work" --model test-model >/dev/null 2>&1 \
    || fail "explicit Codex launch failed"
grep -Eq -- 'mcp_servers\.telegram\.enabled=false --remote ws://127\.0\.0\.1:[0-9]+ --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox --model test-model resume thread-current-cwd$' "$tmp_root/calls" || fail "channel endpoint, canonical thread, default approval and hook-trust bypass, explicit args, or Telegram MCP isolation were changed"
grep -Eq -- 'mcp_servers\.telegram\.enabled=false --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox app-server --listen ws://127\.0\.0\.1:[0-9]+$' "$tmp_root/calls" || fail "Workshop App Server did not bypass hook trust and approvals"

cat > "$tmp_root/bin/fallback-shell" <<'SH'
#!/bin/bash
printf 'opened\n' > "$FAKE_FALLBACK_SHELL_MARKER"
SH
chmod +x "$tmp_root/bin/fallback-shell"
: > "$tmp_root/calls"
FAKE_CODEX_CALLS="$tmp_root/calls" FAKE_FALLBACK_SHELL_MARKER="$tmp_root/fallback-opened" \
    SHELL="$tmp_root/bin/fallback-shell" PATH="$tmp_root/bin:$PATH" KA_HOME="$REPO" \
    KA_CODEX_KEEP_APP_SERVER_ON_TUI_EXIT=1 \
    "$OPS/start-pane.sh" codex fallback "$tmp_root/work" >/dev/null 2>&1 \
    || fail "fallback shell launch failed"
[ -f "$tmp_root/fallback-opened" ] || fail "TUI exit killed the App Server instead of retaining the pane"
ok "Codex App Server survives TUI exit until the pane owner exits"

: > "$tmp_root/calls"
FAKE_CODEX_CALLS="$tmp_root/calls" PATH="$tmp_root/bin:$PATH" KA_HOME="$REPO" \
    "$OPS/start-pane.sh" codex reviewer "$tmp_root/work" --last --dangerously-bypass-approvals-and-sandbox >/dev/null 2>&1 \
    || fail "legacy --last Codex launch failed"
grep -Eq -- 'mcp_servers\.telegram\.enabled=false --remote ws://127\.0\.0\.1:[0-9]+ --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox resume thread-current-cwd$' "$tmp_root/calls" \
    || fail "legacy --last did not select the current-cwd canonical thread"

: > "$tmp_root/calls"
FAKE_CODEX_CALLS="$tmp_root/calls" PATH="$tmp_root/bin:$PATH" KA_HOME="$REPO" \
    "$OPS/start-pane.sh" codex reviewer "$tmp_root/work" >/dev/null 2>&1 \
    || fail "fresh Codex launch failed"
grep -Eq -- 'mcp_servers\.telegram\.enabled=false --remote ws://127\.0\.0\.1:[0-9]+ --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox resume thread-current-cwd$' "$tmp_root/calls" \
    || fail "non-interactive default launch missing"
ok "Codex launch preserves args and selects the current-cwd canonical thread"

: > "$tmp_root/calls"
rm -f "$REPO/state/codex-app-servers/reviewer.thread"
FAKE_CODEX_CALLS="$tmp_root/calls" PATH="$tmp_root/bin:$PATH" KA_HOME="$REPO" \
    "$OPS/start-pane.sh" codex reviewer "$tmp_root/work" "resume --last" --dangerously-bypass-approvals-and-sandbox >/dev/null 2>&1 \
    || fail "legacy combined resume argument failed"
if grep -q -- 'resume --last' "$tmp_root/calls"; then fail "combined resume directive leaked into Codex argv"; fi
grep -Eq -- 'mcp_servers\.telegram\.enabled=false --remote ws://127\.0\.0\.1:[0-9]+ --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox resume thread-current-cwd$' "$tmp_root/calls" \
    || fail "combined resume directive was not normalized"
ok "Codex launch normalizes legacy combined resume arguments"

: > "$tmp_root/calls"
pids=""
for name in one two three four five; do
    FAKE_CODEX_CALLS="$tmp_root/calls" PATH="$tmp_root/bin:$PATH" KA_HOME="$REPO" KA_CHANNEL="$name" \
        "$OPS/start-pane.sh" codex "$name" "$tmp_root/work" --model test-model >/dev/null 2>&1 &
    pids="$pids $!"
done
for pid in $pids; do wait "$pid" || fail "concurrent Codex pane launch failed"; done
ports="$(sed -n 's/.*app-server --listen ws:\/\/127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$tmp_root/calls")"
[ "$(printf '%s\n' "$ports" | sed '/^$/d' | wc -l | tr -d ' ')" = "5" ] || fail "did not observe five App Server launches"
[ "$(printf '%s\n' "$ports" | sort -u | wc -l | tr -d ' ')" = "5" ] || fail "concurrent Codex panes reused an App Server port"
rm -rf "$tmp_root"
ok "concurrent Codex panes allocate distinct App Server ports"

echo "PASS: 17-runtime-codex-contract"
