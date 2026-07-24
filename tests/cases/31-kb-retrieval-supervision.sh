#!/bin/bash
# Regression: a bound-but-unresponsive KB daemon is tolerated while warming,
# then restarted only after a configurable number of consecutive health misses.
set -euo pipefail

REPO="${REPO:-/repo}"
[ -f "$REPO/kb/ops/kb-retrieval/start.sh" ] || REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
OLD_PID=""
trap '[ -z "$OLD_PID" ] || kill -KILL "$OLD_PID" 2>/dev/null || true; rm -rf "$TMP"' EXIT

KA_HOME="$TMP/ka"
ROOT="$KA_HOME/kb/mcp/kb"
FAKE_BIN="$TMP/bin"
mkdir -p "$ROOT/dist" "$KA_HOME/config" "$KA_HOME/state" "$FAKE_BIN"
cp "$REPO/kb/ops/kb-retrieval/start.sh" "$ROOT/start.sh"
cp "$REPO/kb/ops/kb-retrieval/daemon-process.sh" "$ROOT/daemon-process.sh"
printf 'retrieval:\n  daemon:\n    port: 7705\n' > "$KA_HOME/config/config.yaml"

cat > "$ROOT/dist/daemon.mjs" <<'SH'
#!/bin/bash
trap 'exit 0' TERM INT
while :; do sleep 1; done
SH
chmod +x "$ROOT/dist/daemon.mjs"
bash "$ROOT/dist/daemon.mjs" & OLD_PID=$!
printf '%s\n' "$OLD_PID" > "$KA_HOME/state/kb-retrieval.pid"

cat > "$FAKE_BIN/curl" <<'SH'
#!/bin/bash
if [ -f "$TEST_HEALTHY_MARKER" ]; then
  printf '%s\n' '{"ok":true,"ready":true}'
  exit 0
fi
exit 22
SH
cat > "$FAKE_BIN/lsof" <<'SH'
#!/bin/bash
cat "$TEST_PID_FILE"
SH
chmod +x "$FAKE_BIN/curl" "$FAKE_BIN/lsof"

# The replacement launcher only needs to make the health endpoint turn green;
# no real model or listener is involved in this script-level test.
cat > "$ROOT/daemon.sh" <<'SH'
#!/bin/bash
touch "$TEST_HEALTHY_MARKER"
SH
chmod +x "$ROOT/daemon.sh"

export KA_HOME TEST_PID_FILE="$KA_HOME/state/kb-retrieval.pid"
export TEST_HEALTHY_MARKER="$TMP/healthy" PATH="$FAKE_BIN:$PATH"

echo '[1/3] a new PID gets warmup grace and no strike'
out="$(KA_KB_WARM_GRACE_SECONDS=300 bash "$ROOT/start.sh")"
echo "$out" | grep -q 'warming' || { echo "FAIL: $out"; exit 1; }
[ ! -e "$KA_HOME/state/kb-retrieval-health" ] || { echo 'FAIL: warmup created a strike'; exit 1; }
kill -0 "$OLD_PID"

echo '[2/3] mature daemon requires consecutive failures'
out="$(KA_KB_WARM_GRACE_SECONDS=0 KA_KB_HEALTH_FAILURE_LIMIT=3 bash "$ROOT/start.sh")"
echo "$out" | grep -q 'strike 1/3' || { echo "FAIL: $out"; exit 1; }
out="$(KA_KB_WARM_GRACE_SECONDS=0 KA_KB_HEALTH_FAILURE_LIMIT=3 bash "$ROOT/start.sh")"
echo "$out" | grep -q 'strike 2/3' || { echo "FAIL: $out"; exit 1; }
kill -0 "$OLD_PID"

echo '[3/3] threshold stops only the validated daemon and starts replacement'
out="$(KA_KB_WARM_GRACE_SECONDS=0 KA_KB_HEALTH_FAILURE_LIMIT=3 KA_KB_STOP_GRACE_TENTHS=20 bash "$ROOT/start.sh")"
echo "$out" | grep -q 'failed health 3 consecutive times' || { echo "FAIL: $out"; exit 1; }
echo "$out" | grep -q 'started' || { echo "FAIL: $out"; exit 1; }
if kill -0 "$OLD_PID" 2>/dev/null; then echo 'FAIL: wedged daemon still alive'; exit 1; fi
OLD_PID=""
[ ! -e "$KA_HOME/state/kb-retrieval-health" ] || { echo 'FAIL: strike state not cleared'; exit 1; }

echo '31-kb-retrieval-supervision OK'
