#!/bin/bash
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
export KA_HOME="$REPO"
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

tag="$(runtime::ready_match $'header\n  ›  \n? for shortcuts')" || fail "ready fixture rejected"
case "$tag" in prompt-chevron|status) ;; *) fail "unexpected ready tag: $tag" ;; esac
if runtime::ready_match 'Starting Codex...' >/dev/null; then fail "boot screen accepted"; fi
ok "Codex ready detection accepts idle TUI only"

tmp_root="$(mktemp -d)"
mkdir -p "$tmp_root/bin" "$tmp_root/work"
cat > "$tmp_root/bin/codex" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$FAKE_CODEX_CALLS"
if printf '%s\n' "$*" | grep -q 'app-server --listen'; then
    for endpoint in "$@"; do :; done
    port="${endpoint##*:}"
    exec python3 -c 'import socket,sys,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(); time.sleep(30)' "$port"
fi
for arg in "$@"; do [ "$arg" = resume ] && exit 2; done
exit 0
SH
chmod +x "$tmp_root/bin/codex"

FAKE_CODEX_CALLS="$tmp_root/calls" PATH="$tmp_root/bin:$PATH" KA_HOME="$REPO" KA_CHANNEL=main \
    "$OPS/start-pane.sh" codex reviewer "$tmp_root/work" --model test-model >/dev/null 2>&1 \
    || fail "explicit Codex launch failed"
grep -Eq -- '^--remote ws://127\.0\.0\.1:[0-9]+ --model test-model$' "$tmp_root/calls" || fail "channel endpoint or explicit args were changed"

: > "$tmp_root/calls"
FAKE_CODEX_CALLS="$tmp_root/calls" PATH="$tmp_root/bin:$PATH" KA_HOME="$REPO" \
    "$OPS/start-pane.sh" codex reviewer "$tmp_root/work" >/dev/null 2>&1 \
    || fail "Codex resume fallback failed"
grep -Eq -- '^--remote ws://127\.0\.0\.1:[0-9]+ resume --last --sandbox workspace-write --ask-for-approval on-request$' "$tmp_root/calls" \
    || fail "default resume command missing"
grep -Eq -- '^--remote ws://127\.0\.0\.1:[0-9]+ --sandbox workspace-write --ask-for-approval on-request$' "$tmp_root/calls" \
    || fail "fresh fallback command missing"
rm -rf "$tmp_root"
ok "Codex launch preserves args and falls back from empty resume"

echo "PASS: 17-runtime-codex-contract"
