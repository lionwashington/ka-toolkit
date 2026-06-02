#!/bin/bash
# Creates a session, then uses inject-prompt.sh to send text; verifies
# the fake claude received it.
set -euo pipefail

mkdir -p /tmp/proj-a
cat > /tmp/cfg.yaml <<'EOF'
session: testws
panes:
  - name: team-lead
    cwd: /tmp/proj-a
    main: true
    args:
      - "--channels"
      - "plugin:telegram@claude-plugins-official"
EOF

OPS_CONFIG=/tmp/cfg.yaml /repo/ops/bootstrap.sh
sleep 2

# inject-prompt now takes an explicit target pane (no auto-detect).
/repo/ops/lib/inject-prompt.sh testws:0.0 "Run /daily-brief."
sleep 1

LOG=/tmp/claude-proj-a.log
grep -q "<<< Run /daily-brief." "$LOG" || { echo "FAIL: prompt not received"; cat "$LOG"; exit 1; }
echo "prompt delivered"
