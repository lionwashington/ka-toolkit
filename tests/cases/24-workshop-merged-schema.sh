#!/bin/bash
# Verifies workshop.sh consumes the merged single-`mates:` schema correctly:
#   - an entry with `main: true` becomes the lead, bound to channel 'main'
#   - a plain entry's per-entry `args:` are plumbed through to its launch args
#     (the mate_args path added with the schema merge)
#   - `default: false` entries are skipped by a bare run, included with --all
#
# Exercises the real `ka workshop --dry-run` (verb dispatcher → workshop.sh);
# dry-run only echoes, so it never touches tmux.
set -euo pipefail

REPO="${REPO:-/repo}"
KA="$REPO/shared/bin/ka"
[ -x "$KA" ] || { echo "FAIL: $KA not executable"; exit 1; }

mkdir -p /tmp/ms-main /tmp/ms-helper
CFG=/tmp/ms-cfg.yaml
cat > "$CFG" <<'EOF'
session: ms-ws
mates:
  - name: main
    cwd: /tmp/ms-main
    main: true
  - name: helper
    cwd: /tmp/ms-helper
    args:
      - --model
      - claude-haiku-4-5
  - name: optional-one
    cwd: /tmp/ms-helper
    default: false
EOF

run_dry() {  # $1: extra args
    set +e
    out="$(DRY_RUN=1 OPS_CONFIG="$CFG" "$KA" workshop --dry-run $1 2>&1)"
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || { echo "FAIL: ka workshop --dry-run $1 rc=$rc"; echo "$out"; exit 1; }
}

echo "[1/4] main: true entry → lead bound to channel 'main'"
run_dry ""
echo "$out" | grep -qE "main .*channel=main" \
    || { echo "FAIL: main entry should bind to channel 'main'"; echo "$out"; exit 1; }
echo "    ok"

echo "[2/4] plain entry's per-entry args are plumbed through"
echo "$out" | grep -qE "helper .*args=\[.*--model claude-haiku-4-5.*\]" \
    || { echo "FAIL: helper's yaml args not plumbed into its launch args"; echo "$out"; exit 1; }
echo "    ok"

echo "[3/4] default: false entry is skipped by a bare run"
echo "$out" | grep -qE "skipped 1 optional mate" \
    || { echo "FAIL: default:false mate should be skipped without --all"; echo "$out"; exit 1; }
echo "$out" | grep -q "optional-one" \
    && { echo "FAIL: default:false mate must not launch without --all"; echo "$out"; exit 1; }
echo "    ok"

echo "[4/4] --all includes the default: false entry"
run_dry "--all"
echo "$out" | grep -q "optional-one" \
    || { echo "FAIL: --all should include the optional mate"; echo "$out"; exit 1; }
echo "    ok"

rm -f "$CFG"; rm -rf /tmp/ms-main /tmp/ms-helper
echo "24-workshop-merged-schema OK"
