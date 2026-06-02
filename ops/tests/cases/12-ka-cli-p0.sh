#!/bin/bash
# ka CLI P0 smoke tests. Runs inside the repo (Docker or host).
# Covers:
#   1. `ka help` — lists P0 commands, exit 0
#   2. `ka` (no args) — falls through to help, exit 0
#   3. `ka frobnicate` — unknown subcommand, exit 2
#   4. `ka status` — exits non-zero when nothing is running but MUST NOT crash;
#      output includes the ── ka status ── header
#   5. `ka workshop --dry-run` works (verb dispatcher; P2 — bootstrap retired)
set -uo pipefail

REPO="${REPO:-/repo}"
KA="$REPO/bin/ka"

[ -x "$KA" ] || { echo "FAIL: $KA not executable"; exit 1; }

echo "[1/5] ka help"
out="$("$KA" help 2>&1)" || { echo "FAIL: ka help exit=$?"; exit 1; }
echo "$out" | grep -q '^    start' || { echo "FAIL: help missing 'start'"; exit 1; }
echo "$out" | grep -q 'spawn-mates' || { echo "FAIL: help missing 'spawn-mates'"; exit 1; }
echo "    ok"

echo "[2/5] ka (no args) falls through to help"
out="$("$KA" 2>&1)"
rc=$?
# Help prints to stdout and exits 0
[ "$rc" -eq 0 ] || { echo "FAIL: bare ka exit=$rc"; exit 1; }
echo "$out" | grep -q 'USAGE' || { echo "FAIL: bare ka did not print usage"; exit 1; }
echo "    ok"

echo "[3/5] unknown subcommand exits 2"
set +e
"$KA" frobnicate >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -eq 2 ] || { echo "FAIL: expected exit 2 for unknown cmd, got $rc"; exit 1; }
echo "    ok"

echo "[4/5] ka status does not crash when no workshop running"
set +e
out="$("$KA" status 2>&1)"
rc=$?
set -e
# Expect degraded or broken exit code (1 or 2); must not be a bash crash (non-zero != 1/2).
case "$rc" in
    0|1|2) ;;
    *) echo "FAIL: ka status crashed rc=$rc, out=$out"; exit 1 ;;
esac
echo "$out" | grep -q 'ka status' || { echo "FAIL: status header missing"; exit 1; }
echo "$out" | grep -q 'overall' || { echo "FAIL: status overall line missing"; exit 1; }
echo "    ok (rc=$rc)"

echo "[5/5] ka workshop --dry-run works (verb dispatcher)"
mkdir -p /tmp/ka-cli-p0-proj-a
cat > /tmp/ka-cli-p0-cfg.yaml <<'EOF'
session: ka-cli-p0-ws
panes:
  - name: team-lead
    cwd: /tmp/ka-cli-p0-proj-a
    telegram: true
EOF
set +e
out="$(DRY_RUN=1 OPS_CONFIG=/tmp/ka-cli-p0-cfg.yaml "$KA" workshop --dry-run 2>&1)"
rc=$?
set -e
[ "$rc" -eq 0 ] || { echo "FAIL: ka workshop --dry-run rc=$rc"; echo "$out"; exit 1; }
echo "$out" | grep -q 'dry-run summary' || { echo "FAIL: workshop dry-run missing summary"; echo "$out"; exit 1; }
rm -f /tmp/ka-cli-p0-cfg.yaml
rm -rf /tmp/ka-cli-p0-proj-a
echo "    ok"

echo "ka-cli-p0 OK"
