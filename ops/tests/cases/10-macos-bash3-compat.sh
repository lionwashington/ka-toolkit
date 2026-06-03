#!/bin/bash
# macOS ships /bin/bash 3.2.57 (the last GPLv2 release). All ops/*.sh scripts
# must run under that interpreter — no mapfile/readarray/declare -A/${var^^}.
#
# This case:
#   1. Installs a bash-3.2-lookalike shim that rejects bash 4+ builtins at runtime.
#   2. Statically greps ops/**/*.sh for forbidden constructs.
#   3. Dry-runs the real entry (ka workshop) under that shim, clean output.
set -euo pipefail

REPO="${REPO:-/repo}"
FORBIDDEN_RE='(^|[^[:alnum:]_])(mapfile|readarray)([^[:alnum:]_]|$)|declare[[:space:]]+-[A-Za-z]*A|\$\{[A-Za-z_][A-Za-z0-9_]*\^\^|\$\{[A-Za-z_][A-Za-z0-9_]*,,'

echo "[1/3] static scan for bash 4+ only features"
# Strip comments before scanning; skip this test file itself.
hits="$(
    find "$REPO/ops" -name '*.sh' \
        ! -path "*tests/cases/10-macos-bash3-compat.sh" -print0 \
    | while IFS= read -r -d '' f; do
        sed 's/#.*//' "$f" | grep -nE "$FORBIDDEN_RE" \
            | sed "s|^|$f:|" || true
    done
)"
if [ -n "$hits" ]; then
    echo "FAIL: bash 4+ constructs present:"
    echo "$hits"
    exit 1
fi
echo "    clean"

echo "[2/3] dry-run the real entry (ka workshop) under forced bash 3.2 mode"
mkdir -p /tmp/proj-a
cat > /tmp/cfg.yaml <<'EOF'
session: compat-ws
mates:
  - name: team-lead
    cwd: /tmp/proj-a
    main: true
EOF

# BASH_COMPAT=3.2 makes bash 4+ refuse modern syntax where possible.
# bootstrap.sh is retired — `ka workshop` is the canonical entry point.
out="$(BASH_COMPAT=3.2 DRY_RUN=1 OPS_CONFIG=/tmp/cfg.yaml \
    bash "$REPO/bin/ka" workshop --dry-run 2>&1)"
echo "$out" | grep -q 'dry-run summary' \
    || { echo "FAIL: ka workshop --dry-run did not complete"; echo "$out"; exit 1; }
echo "$out" | grep -qiE 'syntax error|unexpected|bad substitution' \
    && { echo "FAIL: bash-syntax errors in output"; echo "$out"; exit 1; }
echo "    ok"

echo "[3/3] smoke: source lib helpers under BASH_COMPAT=3.2"
BASH_COMPAT=3.2 bash -c "source '$REPO/ops/lib/tmux-helpers.sh'; echo sourced" \
    | grep -q sourced || { echo "FAIL: tmux-helpers.sh incompatible"; exit 1; }
echo "    ok"

echo "bash3-compat OK"
