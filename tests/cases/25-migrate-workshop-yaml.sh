#!/bin/bash
# Verifies migrate-workshop-yaml.py converts the legacy panes:/telegram: schema
# to the merged mates:/main: schema: data-preserving, idempotent, the result
# parses under the NEW yaml-parse.sh with the expected records — while the
# ORIGINAL legacy file is (correctly) rejected by the new parser. This is the
# safety proof for the runtime upgrade: migrate → re-parse → same launch set.
set -euo pipefail

REPO="${REPO:-/repo}"
MIGRATE="$REPO/workshop/ops/migrate-workshop-yaml.py"
YAML_PARSE="$REPO/workshop/ops/yaml-parse.sh"
TAB=$'\t'
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/old.yaml" <<'EOF'
session: workshop
runtime: cc
panes:
  - name: main
    cwd: ~/workspace/proj
    telegram: true
    args:
      - --model
      - claude-opus-4-8
mates:
  - name: dev
    cwd: ~/workspace/dev
    description: maintainer
  - name: opt
    cwd: ~/workspace/opt
    default: false
EOF

echo "[1/5] legacy file is rejected by the new parser (proves migration is needed)"
"$YAML_PARSE" "$TMP/old.yaml" >/dev/null 2>&1 && { echo "FAIL: new parser should reject legacy panes:"; exit 1; }
echo "    ok"

echo "[2/5] migrate --check: data-preserving + idempotent"
python3 "$MIGRATE" "$TMP/old.yaml" --check > "$TMP/new.yaml" 2>"$TMP/chk.txt" \
    || { echo "FAIL: migrate --check exited nonzero"; cat "$TMP/chk.txt"; exit 1; }
grep -q "CHECK OK" "$TMP/chk.txt" || { echo "FAIL: --check did not confirm OK"; cat "$TMP/chk.txt"; exit 1; }
echo "    ok"

echo "[3/5] migrated file parses under the new parser with the expected records"
out="$("$YAML_PARSE" "$TMP/new.yaml")"
echo "$out" | grep -qE "^session${TAB}workshop$"                                  || { echo "FAIL: session record"; echo "$out"; exit 1; }
echo "$out" | grep -qE "^mate${TAB}main${TAB}.*proj${TAB}${TAB}1$"             || { echo "FAIL: main entry should remain a regular mate"; echo "$out"; exit 1; }
echo "$out" | grep -qE "^mate_main${TAB}main${TAB}1$"                         || { echo "FAIL: optional main alias record"; echo "$out"; exit 1; }
echo "$out" | grep -qE "^mate_args${TAB}main${TAB}--model\|claude-opus-4-8$"   || { echo "FAIL: main entry args record"; echo "$out"; exit 1; }
echo "$out" | grep -qE "^mate${TAB}dev${TAB}.*dev${TAB}maintainer${TAB}1$"        || { echo "FAIL: dev mate (default=1)"; echo "$out"; exit 1; }
echo "$out" | grep -qE "^mate${TAB}opt${TAB}.*opt${TAB}${TAB}0$"                  || { echo "FAIL: opt mate (default=0)"; echo "$out"; exit 1; }
echo "    ok"

echo "[4/5] telegram: → main: ; panes:/telegram: gone from output"
grep -q "main: true" "$TMP/new.yaml"        || { echo "FAIL: main: true missing"; exit 1; }
grep -qE "^[[:space:]]*telegram:" "$TMP/new.yaml" && { echo "FAIL: telegram: should be gone"; exit 1; }
grep -qE "^panes:" "$TMP/new.yaml"          && { echo "FAIL: panes: should be gone"; exit 1; }
echo "    ok"

echo "[5/5] idempotent: migrating the merged file yields itself byte-for-byte"
python3 "$MIGRATE" "$TMP/new.yaml" 2>/dev/null > "$TMP/new2.yaml"
diff "$TMP/new.yaml" "$TMP/new2.yaml" >/dev/null || { echo "FAIL: not idempotent"; diff "$TMP/new.yaml" "$TMP/new2.yaml"; exit 1; }
echo "    ok"

echo "25-migrate-workshop-yaml OK"
