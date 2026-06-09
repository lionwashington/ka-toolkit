#!/bin/bash
# Verifies the `ka channel` command: it resolves the ACTIVE daemon from
# config.yaml channel_kind (port from channels.<kind>.port), exposes start/stop/
# restart/status/config, and fails gracefully. No real daemon runs in the test
# image, so lifecycle verbs report "down" / "not deployed" rather than acting.
# (The command face is `ka channel`; the internal script/dir stays daemon.sh.)
set -euo pipefail

REPO="${REPO:-/repo}"
KA="$REPO/shared/bin/ka"
[ -x "$KA" ] || { echo "FAIL: $KA not executable"; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "[1/5] ka channel help lists the verbs"
out="$(NO_COLOR=1 HOME="$TMP/h1" "$KA" channel help 2>&1)"
for v in start stop restart status config; do
    echo "$out" | grep -q "ka channel $v" || { echo "FAIL: help missing verb '$v'"; echo "$out"; exit 1; }
done
echo "    ok"

echo "[2/5] unknown verb → exit 2"
set +e; NO_COLOR=1 HOME="$TMP/h2" "$KA" channel frobnicate >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 2 ] || { echo "FAIL: unknown verb rc=$rc (want 2)"; exit 1; }
echo "    ok"

echo "[3/5] no config → telegram; status reports down on 9877 + exit 1"
h="$TMP/h3"; mkdir -p "$h"
set +e; out="$(NO_COLOR=1 HOME="$h" "$KA" channel status 2>&1)"; rc=$?; set -e
echo "$out" | grep -qiE 'telegram.*down|down.*9877|9877' || { echo "FAIL: status didn't report telegram/9877 down"; echo "$out"; exit 1; }
[ "$rc" -eq 1 ] || { echo "FAIL: status-down rc=$rc (want 1)"; exit 1; }
echo "    ok"

echo "[4/5] channel_kind: lark → status targets lark / 9876"
h="$TMP/h4"; mkdir -p "$h"; printf 'channel_kind: lark\n' > "$h/config.yaml"
set +e; out="$(NO_COLOR=1 HOME="$h" KA_CONFIG="$h/config.yaml" "$KA" channel status 2>&1)"; set -e
echo "$out" | grep -qiE 'lark|9876' || { echo "FAIL: status didn't target lark/9876"; echo "$out"; exit 1; }
echo "    ok"

echo "[5/5] start when daemon not deployed → graceful error (non-zero)"
h="$TMP/h5"; mkdir -p "$h"
set +e; out="$(NO_COLOR=1 HOME="$h" "$KA" channel start 2>&1)"; rc=$?; set -e
echo "$out" | grep -qiE 'not deployed|install' || { echo "FAIL: start should report not-deployed"; echo "$out"; exit 1; }
[ "$rc" -ne 0 ] || { echo "FAIL: start should fail when daemon not deployed"; exit 1; }
echo "    ok"

echo "27-ka-channel OK"
