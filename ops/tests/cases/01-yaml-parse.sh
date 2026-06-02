#!/bin/bash
# Verifies yaml-parse.sh emits the expected flat records.
# P2: yaml-parse no longer prepends --teammate-mode / --channels (CC team
# retired, telegram goes through the daemon). Args are emitted verbatim.
set -euo pipefail

REPO="${REPO:-/repo}"
YAML_PARSE="$REPO/ops/lib/yaml-parse.sh"

cat > /tmp/c.yaml <<'EOF'
session: tsess
panes:
  - name: a
    cwd: /tmp
    main: true
    args:
      - "--flag"
      - "x"
  - name: b
    cwd: /root
EOF

out="$("$YAML_PARSE" /tmp/c.yaml)"
echo "$out"
echo "$out" | grep -qx "session	tsess"
# Main pane: args emitted verbatim, NO --teammate-mode prepend (team retired).
echo "$out" | grep -qx "pane	a	/tmp	1	--flag|x" \
    || { echo "FAIL: main pane args should be verbatim (no teammate-mode prepend)"; echo "$out"; exit 1; }
# Non-main pane: no args.
echo "$out" | grep -qx "pane	b	/root	0	"

# telegram: true marks the pane as main (main=1) but does NOT prepend
# --channels plugin:telegram (telegram goes through the daemon now).
cat > /tmp/c2.yaml <<'EOF'
session: tg
panes:
  - name: lead
    cwd: /tmp
    telegram: true
    args:
      - "--flag"
EOF
out2="$("$YAML_PARSE" /tmp/c2.yaml)"
echo "$out2" | grep -qx "pane	lead	/tmp	1	--flag" \
    || { echo "FAIL: telegram pane should be main=1 with no plugin/teammate prepend"; echo "$out2"; exit 1; }

echo "01-yaml-parse OK"
