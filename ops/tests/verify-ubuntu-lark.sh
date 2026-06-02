#!/bin/bash
# verify-ubuntu-lark.sh — runs INSIDE the ubuntu-lark.Dockerfile image to prove
# "full ka + lark daemon" works on a fresh Linux box. Exits non-zero on any failure.
set -uo pipefail
cd /repo
PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "==> env: $(uname -s -m) | node $(node -v) | pnpm $(pnpm -v) | python3 $(python3 --version 2>&1)"

echo "[1] install.sh full dry-run (KA_CHANNEL=lark) — flow must not crash on Linux"
if KA_CHANNEL=lark KA_RUNTIME_ROOT=/tmp/rt ./install.sh --dry-run --switch >/tmp/dry.log 2>&1; then
  grep -q "lark daemon →" /tmp/dry.log && ok "lark daemon planned" || bad "lark daemon not planned"
  grep -q "telegram daemon → SKIPPED" /tmp/dry.log && ok "telegram skipped" || bad "telegram not skipped"
  grep -qE "cron → Linux: skip" /tmp/dry.log && ok "switch_cron Linux-guarded" || bad "switch_cron not guarded"
  grep -q "dependency precheck" /tmp/dry.log && ok "precheck ran" || bad "precheck missing"
else
  bad "install.sh --dry-run crashed"; sed -n '1,40p' /tmp/dry.log
fi

echo "[2] build lark daemon bundle on Linux (esbuild)"
if KA_CHANNEL=lark KA_RUNTIME_ROOT=/tmp/rt ./install.sh --only daemon >/tmp/build.log 2>&1; then
  [ -f /tmp/rt/runtime/lark-daemon/daemon.mjs ] && ok "lark daemon.mjs built" || bad "daemon.mjs missing"
else
  bad "deploy_lark_daemon failed"; tail -10 /tmp/build.log
fi

echo "[3] run lark daemon bundle on Linux + /api/status"
mkdir -p /tmp/ld
cat > /tmp/ld/config.json <<'JSON'
{ "self_open_id":"ou_x","poll_interval_seconds":60,"page_size":10,"lark_cli_bin":"true","http_host":"127.0.0.1","http_port":9876,"groups":{} }
JSON
KA_DAEMON_DATA_DIR=/tmp/ld node /tmp/rt/runtime/lark-daemon/daemon.mjs >/tmp/ld/out.log 2>&1 &
sleep 2
st="$(node -e 'fetch("http://127.0.0.1:9876/api/status").then(r=>r.json()).then(d=>console.log(d.ok)).catch(()=>console.log("ERR"))')"
[ "$st" = "true" ] && ok "/api/status ok=true on Linux" || { bad "/api/status failed"; tail -5 /tmp/ld/out.log; }

echo "[4] lark tests (unit + e2e) on Linux"
if (cd packages/lark-channel && node --experimental-strip-types --test tests/unit.test.ts tests/e2e.test.ts >/tmp/larktest.log 2>&1); then
  ok "lark tests passed: $(grep -E '^# pass|pass [0-9]' /tmp/larktest.log | tail -1 | tr -d '#')"
else
  bad "lark tests failed"; grep -E "fail|not ok|Error" /tmp/larktest.log | head -8
fi

echo "[5] crontab cron backend (Linux)"
source ops/lib/cron/backend-adapter.sh
load_backend "$(detect_backend)"
if [ "$(backend::name)" = "crontab" ]; then ok "detect_backend → crontab"; else bad "backend is $(backend::name)"; fi
export KA_REPO_ROOT=/repo KA_CRON_SCHEDULE="every 5m" KA_CRON_LOG=/tmp/j.log
if backend::install testjob /dev/null && backend::is_loaded testjob; then ok "crontab install + is_loaded"; else bad "crontab install/is_loaded"; fi
backend::uninstall testjob
backend::is_loaded testjob && bad "uninstall left it" || ok "crontab uninstall"

echo "[6] workshop binds lark daemon (KA_CHANNEL_KIND=lark dry-run)"
# dry-run prints `[dry-run] .../lark-daemon/start.sh # ensure lark-channel daemon up`
# then exits on the example yaml's nonexistent cwd — so assert the ensure line
# (lark-daemon dir + lark-channel daemon), NOT the status-verb "port 9876" line
# which lives on a different code path and isn't reached here.
wout="$(env -u KA_CHANNEL_PORT KA_CHANNEL_KIND=lark KA_REPO_ROOT=/repo bash ops/cli/workshop.sh --dry-run 2>&1 || true)"
if echo "$wout" | grep -q "lark-daemon" && echo "$wout" | grep -q "lark-channel daemon"; then
  ok "workshop → binds lark-daemon (lark-channel)"
else
  bad "workshop lark binding wrong"; echo "$wout" | grep -iE "daemon|lark|port" | head -3
fi

echo ""
echo "==> RESULT: ${PASS} pass / ${FAIL} fail"
[ "$FAIL" -eq 0 ]
