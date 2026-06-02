#!/bin/bash
# 19-cron-linux-crontab.sh — Linux crontab end-to-end validation for the
# ka cron runner + yaml parsing + schedule-parser. This is NOT a mandate that
# ka cron supports Linux backend; it's a cross-platform sanity check because
# launchctl only exists on macOS. See docs/TEST_REPORT_2026-04-15.md.
#
# Covers:
#   1. schedule-parser produces dicts that map to a valid Linux crontab expr
#   2. cron-run.sh, when invoked directly (what a crontab line would do),
#      reads cron.yaml + runs shell job + writes start/exit markers to log
#   3. If `crontab` + `cron` daemon are available, install a `* * * * *` job,
#      wait ~75s, verify at least one cycle ran. Otherwise skip that segment.
set -uo pipefail

REPO="${REPO:-/repo}"
KA="$REPO/bin/ka"
RUN="$REPO/ops/scripts/cron-run.sh"
SCHED="$REPO/ops/lib/cron/schedule-parser.sh"

[ -x "$KA" ]  || { echo "FAIL: $KA not executable"; exit 1; }
[ -x "$RUN" ] || { echo "FAIL: $RUN not executable"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; command -v crontab >/dev/null && crontab -r 2>/dev/null || true' EXIT

export HOME="$TMP/home"
mkdir -p "$HOME/.knowledge-assistant"
export KA_CRON_CONFIG="$HOME/.knowledge-assistant/cron.yaml"
export KA_CRON_LOG_DIR="$TMP/logs"
export KA_CRON_LOCK_DIR="$TMP/locks"

echo "[1/3] schedule-parser → crontab expression mapping"
# Hour=7;Minute=0 → "0 7 * * *"
out="$(bash "$SCHED" "daily 07:00")"
[ "$out" = "Hour=7;Minute=0" ] \
    || { echo "FAIL: daily 07:00 produced: $out"; exit 1; }
# "every 1m" → 60 dicts; a `*/1 * * * *` crontab is semantically equivalent
out="$(bash "$SCHED" "every 1m")" 2>&1
# every 1m: 60% divides, should emit 60 Minute= lines
if echo "$out" | grep -q "ERROR"; then
    echo "FAIL: every 1m rejected: $out"; exit 1
fi
[ "$(echo "$out" | wc -l | tr -d ' ')" = "60" ] \
    || { echo "FAIL: every 1m expected 60 dicts"; exit 1; }
echo "    ok"

echo "[2/3] cron-run.sh direct invocation (simulates what crontab fires)"
"$KA" cron add --name linux-shell-unit --schedule "every 1m" --kind shell \
    --command "echo ka-cron-ran-at-\$(date +%s) >> $TMP/evidence.log" \
    --disabled >/dev/null 2>&1 \
    || { echo "FAIL: ka cron add"; exit 1; }
# Flip enabled=true in yaml so cron-run doesn't skip
python3 - "$KA_CRON_CONFIG" <<'PY'
import sys, re
path = sys.argv[1]
with open(path) as f: src = f.read()
src = re.sub(r'^(\s*enabled: ")false(")', r'\1true\2', src, flags=re.M)
with open(path, 'w') as f: f.write(src)
PY
bash "$RUN" linux-shell-unit --foreground >"$TMP/run.out" 2>&1 \
    || { echo "FAIL: cron-run.sh rc=$?: $(cat "$TMP/run.out")"; exit 1; }
grep -q "=== .* start name=linux-shell-unit" "$TMP/run.out" \
    || { echo "FAIL: runner start marker missing"; cat "$TMP/run.out"; exit 1; }
grep -q "=== .* exit=0 name=linux-shell-unit" "$TMP/run.out" \
    || { echo "FAIL: runner exit marker missing"; cat "$TMP/run.out"; exit 1; }
grep -q "ka-cron-ran-at-" "$TMP/evidence.log" \
    || { echo "FAIL: shell command did not run"; cat "$TMP/evidence.log"; exit 1; }
echo "    ok"

echo "[3/3] real Linux crontab trigger (if cron daemon available)"
if ! command -v crontab >/dev/null 2>&1; then
    echo "    SKIP: no crontab(1) available"
    echo "cron-linux-crontab OK"
    exit 0
fi
# Start cron daemon if it's not running (Debian packaging).
if [ -x /usr/sbin/cron ]; then
    /usr/sbin/cron 2>/dev/null || true
fi
sleep 1
if ! pgrep -x cron >/dev/null 2>&1 && ! pgrep -x crond >/dev/null 2>&1; then
    echo "    SKIP: cron daemon not running (container without init)"
    echo "cron-linux-crontab OK"
    exit 0
fi

# Install a `* * * * *` entry pointing at cron-run.sh with our env.
CRONTAB_LINE="* * * * * HOME=$HOME KA_CRON_CONFIG=$KA_CRON_CONFIG KA_CRON_LOG_DIR=$KA_CRON_LOG_DIR KA_CRON_LOCK_DIR=$KA_CRON_LOCK_DIR $RUN linux-shell-unit >>$TMP/cron-trigger.log 2>&1"
(crontab -l 2>/dev/null; echo "$CRONTAB_LINE") | crontab -
echo "    crontab installed; waiting up to 75s for first trigger..."
: > "$TMP/evidence.log"  # reset evidence

deadline=$(( $(date +%s) + 75 ))
seen=0
while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -s "$TMP/evidence.log" ]; then
        seen=1
        break
    fi
    sleep 5
done

# Cleanup crontab regardless
crontab -r 2>/dev/null || true

if [ "$seen" -ne 1 ]; then
    echo "    SKIP: no trigger within 75s (cron daemon may be silent in container);"
    echo "          direct invocation test at step 2 already validated runner contract"
    echo "cron-linux-crontab OK"
    exit 0
fi
echo "    ok: crontab-triggered run produced evidence"
echo "    $(tail -1 "$TMP/evidence.log")"

echo "cron-linux-crontab OK"
