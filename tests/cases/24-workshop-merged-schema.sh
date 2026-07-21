#!/bin/bash
# Verifies workshop.sh consumes the merged single-`mates:` schema correctly:
#   - optional `main: true` changes only that entry's channel alias
#   - a zero-main config launches every selected entry under its own name
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
    out="$(KA_HOME="$REPO" DRY_RUN=1 OPS_CONFIG="$CFG" "$KA" workshop --dry-run $1 2>&1)"
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || { echo "FAIL: ka workshop --dry-run $1 rc=$rc"; echo "$out"; exit 1; }
}

echo "[1/9] main: true entry → optional alias bound to channel 'main'"
run_dry ""
echo "$out" | grep -qE "main .*channel=main" \
    || { echo "FAIL: main entry should bind to channel 'main'"; echo "$out"; exit 1; }
echo "    ok"

echo "[2/9] plain entry's per-entry args are plumbed through"
echo "$out" | grep -qE "helper .*args=\[.*--model claude-haiku-4-5.*\]" \
    || { echo "FAIL: helper's yaml args not plumbed into its launch args"; echo "$out"; exit 1; }
echo "    ok"

echo "[3/9] default: false entry is skipped by a bare run"
echo "$out" | grep -qE "skipped 1 optional mate" \
    || { echo "FAIL: default:false mate should be skipped without --all"; echo "$out"; exit 1; }
echo "$out" | grep -q "optional-one" \
    && { echo "FAIL: default:false mate must not launch without --all"; echo "$out"; exit 1; }
echo "    ok"

echo "[4/9] --all includes the default: false entry"
run_dry "--all"
echo "$out" | grep -q "optional-one" \
    || { echo "FAIL: --all should include the optional mate"; echo "$out"; exit 1; }
echo "    ok"

echo "[5/9] Codex per-entry runtime override is consumed"
cat >> "$CFG" <<'EOF'
  - name: future-runtime
    cwd: /tmp/ms-helper
    runtime: codex
EOF
out="$(KA_HOME="$REPO" DRY_RUN=1 OPS_CONFIG="$CFG" "$KA" workshop --dry-run --only future-runtime 2>&1)"
rc=$?
[ "$rc" -eq 0 ] || { echo "FAIL: Codex per-entry runtime rc=$rc"; echo "$out"; exit 1; }
echo "$out" | grep -q "runtime=codex" \
    || { echo "FAIL: Codex runtime override was not consumed"; echo "$out"; exit 1; }
echo "    ok"

echo "[6/9] unavailable runtime still fails closed"
sed 's/runtime: codex/runtime: gemini/' "$CFG" > "$CFG.gemini"
set +e
out="$(KA_HOME="$REPO" DRY_RUN=1 OPS_CONFIG="$CFG.gemini" "$KA" workshop --dry-run --only future-runtime 2>&1)"
rc=$?
set -e
[ "$rc" -eq 78 ] || { echo "FAIL: unavailable per-entry runtime rc=$rc (want 78)"; echo "$out"; exit 1; }
echo "$out" | grep -q "unsupported runtime: gemini" \
    || { echo "FAIL: unavailable runtime was not rejected"; echo "$out"; exit 1; }
echo "    ok"

echo "[7/9] zero-main config launches agents under their own channel names"
cat > "$CFG.zero" <<'EOF'
session: ms-no-main
mates:
  - name: alpha
    cwd: /tmp/ms-main
  - name: beta
    cwd: /tmp/ms-helper
EOF
out="$(KA_HOME="$REPO" DRY_RUN=1 OPS_CONFIG="$CFG.zero" "$KA" workshop --dry-run 2>&1)"
echo "$out" | grep -qE "alpha .*channel=alpha" || { echo "FAIL: alpha not self-routed"; echo "$out"; exit 1; }
echo "$out" | grep -qE "beta .*channel=beta" || { echo "FAIL: beta not self-routed"; echo "$out"; exit 1; }
echo "$out" | grep -q 'channel=main' && { echo "FAIL: zero-main config invented main"; echo "$out"; exit 1; }
echo "    ok"

echo "[8/9] main alias obeys default: false like every other mate"
cat > "$CFG.optional-main" <<'EOF'
session: ms-optional-main
mates:
  - name: dormant
    cwd: /tmp/ms-main
    main: true
    default: false
  - name: active
    cwd: /tmp/ms-helper
EOF
out="$(KA_HOME="$REPO" DRY_RUN=1 OPS_CONFIG="$CFG.optional-main" "$KA" workshop --dry-run 2>&1)"
echo "$out" | grep -qE "active .*channel=active" || { echo "FAIL: active mate not launched"; echo "$out"; exit 1; }
echo "$out" | grep -qE "dormant .*channel=main" && { echo "FAIL: default:false main alias was privileged"; echo "$out"; exit 1; }
echo "    ok"

echo "[9/9] main alias has no removal privilege"
cp "$CFG" "$CFG.remove"
python3 "$REPO/workshop/ops/yaml-remove-mate.py" "$CFG.remove" main >/dev/null
grep -q 'name: main' "$CFG.remove" && { echo "FAIL: main alias was not removable"; exit 1; }
echo "    ok"

rm -f "$CFG" "$CFG.gemini" "$CFG.zero" "$CFG.optional-main" "$CFG.remove"; rm -rf /tmp/ms-main /tmp/ms-helper
echo "24-workshop-merged-schema OK"
