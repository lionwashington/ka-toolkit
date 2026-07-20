#!/bin/bash
set -euo pipefail

REPO="${REPO:-/repo}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/shared/bin" "$TMP/cron" "$TMP/config" "$TMP/state" "$TMP/logs"
ln -s "$REPO/shared/ops" "$TMP/shared/ops"
ln -s "$REPO/cron/ops" "$TMP/cron/ops"

cat > "$TMP/config/cron.yaml" <<'EOF'
version: 1
jobs:
  - name: kb-distill
    schedule: "every 12h"
    kind: ka-cli
    command: "kb distill --background"
EOF

cat > "$TMP/shared/bin/ka" <<'EOF'
#!/bin/bash
state="$KA_HOME/state/distill-current.json"
(
  sleep 1
  printf '%s\n' '{"status":"done"}' > "$state"
) &
pid=$!
printf '%s\n' "distill-bg: pid=$pid log=$KA_HOME/state/test.log status=$state snapshot=1"
EOF
chmod +x "$TMP/shared/bin/ka"

started="$(date +%s)"
set +e
KA_HOME="$TMP" KA_STATE_DIR="$TMP/state" KA_CRON_CONFIG="$TMP/config/cron.yaml" KA_CRON_LOG_DIR="$TMP/logs" \
  bash "$REPO/cron/ops/cron-run.sh" kb-distill --foreground > "$TMP/output"
rc=$?
set -e
elapsed=$(( $(date +%s) - started ))

[ "$rc" -eq 0 ] || { echo "FAIL: cron runner returned $rc"; cat "$TMP/output"; exit 1; }
[ "$elapsed" -ge 1 ] || { echo "FAIL: cron runner returned before the worker"; exit 1; }
grep -q 'finished with status=done' "$TMP/output" \
  || { echo "FAIL: durable distill completion was not validated"; cat "$TMP/output"; exit 1; }

echo "30-cron-distill-wait OK"
