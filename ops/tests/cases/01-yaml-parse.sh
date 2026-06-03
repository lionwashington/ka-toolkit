#!/bin/bash
# Verifies yaml-parse.sh emits the expected flat records.
#
# NEW SCHEMA (single `mates:` section): every agent lives under `mates:`.
# `main: true` marks the lead (emitted as a `pane` record, channel forced to
# `main` downstream); everything else is a spawned mate (`mate` record).
# Each entry supports: name / cwd / args / description / main / default.
#   - main    defaults to false
#   - default defaults to true
# Args are emitted verbatim (no --teammate-mode / --channels prepend — the CC
# team mechanism is retired; telegram goes through the daemon). Mate args ride
# a separate `mate_args` side-record (like `mate_runtime`) so 4-field `mate`
# consumers stay untouched.
#
# The legacy `panes:` section and `telegram:` key are REMOVED — using either is
# a hard error that points at the new schema.
set -euo pipefail

REPO="${REPO:-/repo}"
YAML_PARSE="$REPO/ops/lib/yaml-parse.sh"

# --- main (main: true) → pane record; plain entry → mate record --------------
cat > /tmp/c.yaml <<'EOF'
session: tsess
mates:
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
# main: true → pane record, main=1, args verbatim.
echo "$out" | grep -qx "pane	a	/tmp	1	--flag|x" \
    || { echo "FAIL: main entry should emit a pane record with verbatim args"; echo "$out"; exit 1; }
# plain entry → mate record, default defaults to 1, no main.
echo "$out" | grep -qx "mate	b	/root		1" \
    || { echo "FAIL: plain entry should emit a mate record with default=1"; echo "$out"; exit 1; }

# --- default: false → default=0; mate args → mate_args side-record -----------
cat > /tmp/c2.yaml <<'EOF'
session: s2
mates:
  - name: lead
    cwd: /tmp
    main: true
  - name: opt
    cwd: /opt
    description: optional one
    default: false
    args:
      - "--model"
      - "claude-opus-4-8"
EOF
out2="$("$YAML_PARSE" /tmp/c2.yaml)"
echo "$out2" | grep -qx "pane	lead	/tmp	1	" \
    || { echo "FAIL: lead pane (no args) should be main=1 with empty args"; echo "$out2"; exit 1; }
echo "$out2" | grep -qx "mate	opt	/opt	optional one	0" \
    || { echo "FAIL: default:false mate should emit default=0 with its description"; echo "$out2"; exit 1; }
echo "$out2" | grep -qx "mate_args	opt	--model|claude-opus-4-8" \
    || { echo "FAIL: mate args should ride a mate_args side-record"; echo "$out2"; exit 1; }

# --- legacy `panes:` is a hard error ----------------------------------------
cat > /tmp/c3.yaml <<'EOF'
session: legacy
panes:
  - name: lead
    cwd: /tmp
    main: true
EOF
if "$YAML_PARSE" /tmp/c3.yaml >/dev/null 2>&1; then
    echo "FAIL: legacy panes: section should be rejected"; exit 1
fi

# --- legacy `telegram:` key is a hard error ---------------------------------
cat > /tmp/c4.yaml <<'EOF'
session: legacy2
mates:
  - name: lead
    cwd: /tmp
    telegram: true
EOF
if "$YAML_PARSE" /tmp/c4.yaml >/dev/null 2>&1; then
    echo "FAIL: legacy telegram: key should be rejected"; exit 1
fi

echo "01-yaml-parse OK"
