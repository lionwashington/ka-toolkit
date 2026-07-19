#!/bin/bash
# ka cron Phase 1 unit tests. Focus: parser/generator correctness + yaml CRUD
# idempotency. Skips backend (launchctl) operations so the suite runs on
# Debian/Docker without macOS.
#
# Covers:
#   1. schedule-parser: every Nm / every Nh / daily HH:MM / 5-field cron
#   2. plist-gen byte-stable for fixed inputs (single dict + array)
#   3. cron yaml init template parses cleanly (jobs section recognised)
#   4. ka cron add: writes record, idempotent re-validation
#   5. ka cron disable / enable: toggles enabled flag without duplicating block
#   6. ka cron remove: drops block; second remove is a no-op
#   7. ka cron list: detects yaml drift (manual edit reflected)
#   8. ka cron import: legacy plist → yaml entry; second run no duplicate
set -uo pipefail

REPO="${REPO:-/repo}"
KA="$REPO/shared/bin/ka"
LIB="$REPO/cron/ops/internals"
PARSE="$LIB/parse-yaml.sh"
SCHED="$LIB/schedule-parser.sh"
PLIST="$LIB/plist-gen.sh"

[ -x "$KA" ] || { echo "FAIL: $KA not executable"; exit 1; }
[ -f "$SCHED" ] || { echo "FAIL: $SCHED missing"; exit 1; }
[ -f "$PLIST" ] || { echo "FAIL: $PLIST missing"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"
mkdir -p "$HOME/.knowledge-assistant"
export KA_CRON_CONFIG="$HOME/.knowledge-assistant/cron.yaml"
export KA_CRON_LOG_DIR="$TMP/logs"
# Force backend to be a no-op so add/install/remove don't try to talk to launchctl.
# The backend-adapter detects launchd by `command -v launchctl`. On Debian docker
# it returns "unknown" → install/uninstall ops bail out gracefully.

echo "[1/9] schedule-parser handles all four syntaxes"
out="$(bash "$SCHED" "every 5m")" || { echo "FAIL: every 5m"; exit 1; }
[ "$(echo "$out" | wc -l | tr -d ' ')" = "12" ] || { echo "FAIL: every 5m expected 12 lines got: $out"; exit 1; }

out="$(bash "$SCHED" "every 2h")" || { echo "FAIL: every 2h"; exit 1; }
[ "$(echo "$out" | wc -l | tr -d ' ')" = "12" ] || { echo "FAIL: every 2h expected 12 dicts"; exit 1; }
echo "$out" | head -1 | grep -q '^Hour=0;Minute=0$' || { echo "FAIL: every 2h first dict wrong: $(echo "$out" | head -1)"; exit 1; }

out="$(bash "$SCHED" "daily 07:00")" || { echo "FAIL: daily 07:00"; exit 1; }
[ "$out" = "Hour=7;Minute=0" ] || { echo "FAIL: daily 07:00 got: $out"; exit 1; }

out="$(bash "$SCHED" "3 1-23/2 * * *")" || { echo "FAIL: kb-distill cron"; exit 1; }
[ "$(echo "$out" | wc -l | tr -d ' ')" = "12" ] || { echo "FAIL: 3 1-23/2 expected 12 dicts"; exit 1; }
echo "$out" | head -1 | grep -q '^Hour=1;Minute=3$' || { echo "FAIL: cron first dict wrong"; exit 1; }

# Error path
set +e
bash "$SCHED" "weekly mondays" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: bad schedule should not exit 0"; exit 1; }
echo "    ok"

echo "[2/9] plist-gen byte-stable for fixed input"
ENV_REPO="$REPO" \
KA_HOME="$REPO" \
KA_CRON_NAME="unit-single" \
KA_CRON_SCHEDULE="daily 07:00" \
KA_CRON_LOG="/tmp/u.log" \
    bash "$PLIST" > "$TMP/single.plist" || { echo "FAIL: plist-gen single"; exit 1; }

# Expected: single dict (not array) when N=1
grep -q '<key>StartCalendarInterval</key>' "$TMP/single.plist" || { echo "FAIL: plist missing StartCalendarInterval"; exit 1; }
if grep -q '<array>' "$TMP/single.plist" | head -2 | grep -q 'StartCalendar'; then :; fi
# No <array> immediately after StartCalendarInterval key → confirm dict form
awk '/StartCalendarInterval/{getline; print}' "$TMP/single.plist" | grep -q '<dict>' \
    || { echo "FAIL: single-dict plist used array form"; cat "$TMP/single.plist"; exit 1; }
grep -q '<string>com.knowledge-assistant.ka.cron.unit-single</string>' "$TMP/single.plist" \
    || { echo "FAIL: label wrong"; exit 1; }

# Re-run → byte-identical (deterministic)
KA_HOME="$REPO" \
KA_CRON_NAME="unit-single" \
KA_CRON_SCHEDULE="daily 07:00" \
KA_CRON_LOG="/tmp/u.log" \
    bash "$PLIST" > "$TMP/single2.plist"
cmp -s "$TMP/single.plist" "$TMP/single2.plist" \
    || { echo "FAIL: plist-gen not deterministic"; diff "$TMP/single.plist" "$TMP/single2.plist"; exit 1; }

# Multi-dict (array form)
KA_HOME="$REPO" \
KA_CRON_NAME="unit-multi" \
KA_CRON_SCHEDULE="every 2h" \
KA_CRON_LOG="/tmp/m.log" \
    bash "$PLIST" > "$TMP/multi.plist"
awk '/StartCalendarInterval/{getline; print}' "$TMP/multi.plist" | grep -q '<array>' \
    || { echo "FAIL: multi-dict plist did not use array form"; exit 1; }
[ "$(grep -c '<dict>' "$TMP/multi.plist")" -ge 13 ] \
    || { echo "FAIL: multi.plist expected ≥13 <dict> tags (1 outer + 12 entries)"; exit 1; }
echo "    ok"

echo "[3/9] ka cron add initialises yaml + writes record"
"$KA" cron add --name unit-job --schedule "every 30m" --kind shell \
    --command "echo hi" --description "unit" --disabled >/dev/null 2>&1 \
    || { echo "FAIL: ka cron add"; exit 1; }
[ -f "$KA_CRON_CONFIG" ] || { echo "FAIL: yaml not created"; exit 1; }
grep -q '^jobs:$' "$KA_CRON_CONFIG" \
    || { echo "FAIL: yaml jobs section not in canonical form"; cat "$KA_CRON_CONFIG"; exit 1; }
echo "    ok"

echo "[4/9] cron yaml is parser-clean"
recs="$(bash "$PARSE" "$KA_CRON_CONFIG" 2>/dev/null)"
echo "$recs" | grep -q $'^job\tunit-job\tschedule\tevery 30m$' \
    || { echo "FAIL: parse-yaml did not see schedule"; echo "$recs"; exit 1; }
echo "$recs" | grep -q $'^job\tunit-job\tkind\tshell$' \
    || { echo "FAIL: kind missing"; exit 1; }
echo "$recs" | grep -q $'^job\tunit-job\tenabled\tfalse$' \
    || { echo "FAIL: --disabled flag not reflected"; exit 1; }

# Idempotency: re-add with same name is a no-op (no duplicate block)
"$KA" cron add --name unit-job --schedule "every 30m" --kind shell \
    --command "echo hi" --disabled >/dev/null 2>&1 \
    || { echo "FAIL: idempotent re-add should succeed"; exit 1; }
[ "$(grep -c '^  - name: unit-job' "$KA_CRON_CONFIG")" = "1" ] \
    || { echo "FAIL: duplicate job block written"; exit 1; }
echo "    ok"

echo "[5/9] ka cron enable/disable toggles flag without duplicating block"
"$KA" cron enable unit-job >/dev/null 2>&1 || true
recs="$(bash "$PARSE" "$KA_CRON_CONFIG" 2>/dev/null)"
echo "$recs" | grep -q $'^job\tunit-job\tenabled\ttrue$' \
    || { echo "FAIL: enable did not set enabled=true"; echo "$recs"; exit 1; }
[ "$(grep -c '^  - name: unit-job' "$KA_CRON_CONFIG")" = "1" ] \
    || { echo "FAIL: enable duplicated block"; exit 1; }

"$KA" cron disable unit-job >/dev/null 2>&1 || true
recs="$(bash "$PARSE" "$KA_CRON_CONFIG" 2>/dev/null)"
echo "$recs" | grep -q $'^job\tunit-job\tenabled\tfalse$' \
    || { echo "FAIL: disable did not set enabled=false"; exit 1; }
echo "    ok"

echo "[6/9] ka cron remove drops block; second remove is no-op"
"$KA" cron remove unit-job >/dev/null 2>&1 || true
[ "$(grep -c '^  - name: unit-job' "$KA_CRON_CONFIG")" = "0" ] \
    || { echo "FAIL: remove did not drop block"; exit 1; }
# Second remove should not crash
set +e
"$KA" cron remove unit-job >/dev/null 2>&1
rc=$?
set -e
case "$rc" in
    0|1) ;;
    *) echo "FAIL: second remove crashed rc=$rc"; exit 1 ;;
esac
echo "    ok"

echo "[7/9] ka cron list detects yaml drift (manual edit reflected)"
# Manually append a job
cat >> "$KA_CRON_CONFIG" <<'EOF'
  - name: drift-job
    schedule: "daily 12:00"
    kind: shell
    command: "echo drift"
    enabled: false
EOF
out="$("$KA" cron list 2>&1)" || true
echo "$out" | grep -q 'drift-job' \
    || { echo "FAIL: ka cron list did not pick up manual edit"; echo "$out"; exit 1; }
echo "    ok"

echo "[8/9] ka cron import: legacy plist scan is bounded, no-op when none"
# Use isolated HOME with no LaunchAgents dir → import should report "no legacy"
RUN_HOME="$(mktemp -d)"
mkdir -p "$RUN_HOME/.knowledge-assistant"
set +e
out="$(HOME="$RUN_HOME" KA_CRON_CONFIG="$RUN_HOME/.knowledge-assistant/cron.yaml" \
    "$KA" cron import 2>&1)"
rc=$?
set -e
echo "$out" | grep -q 'no legacy' \
    || { echo "FAIL: import on empty LA dir should say 'no legacy', got: $out"; exit 1; }
[ "$rc" -eq 0 ] || { echo "FAIL: empty import rc=$rc"; exit 1; }
rm -rf "$RUN_HOME"
echo "    ok"

echo "[9/9] legacy kb-distill migrates to direct ka-cli execution"
grep -Eq 'kb-distill\).*ka-cli\|kb distill --background' "$REPO/cron/ops/cmd/import.sh" \
    || { echo "FAIL: kb-distill import still depends on prompt injection"; exit 1; }
echo "    ok"

echo "ka-cron OK"
