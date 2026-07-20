#!/bin/bash
# An inject-prompt job must not report success when no configured pane exists.
set -euo pipefail

REPO="${REPO:-/repo}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/logs"

cat > "$TMP/cron.yaml" <<'EOF'
version: 1
jobs:
  - name: missing-pane
    schedule: "daily 07:00"
    kind: inject-prompt
    command: "/daily-brief"
    enabled: true
EOF

# cron-run only uses node here to read channels.inject. Return a configured
# target whose pane intentionally does not exist.
cat > "$TMP/bin/node" <<'EOF'
#!/bin/bash
printf '%s\n' main
EOF
chmod +x "$TMP/bin/node"

set +e
out="$(PATH="$TMP/bin:$PATH" KA_HOME="$REPO" KA_CRON_CONFIG="$TMP/cron.yaml" \
  KA_CRON_LOG_DIR="$TMP/logs" bash "$REPO/cron/ops/cron-run.sh" missing-pane --foreground 2>&1)"
rc=$?
set -e

[ "$rc" -ne 0 ] || { echo "FAIL: missing pane was reported as success"; echo "$out"; exit 1; }
echo "$out" | grep -q "no pane resolved" || { echo "FAIL: missing-pane diagnostic absent"; echo "$out"; exit 1; }
echo "18-cron-inject-failure OK"
