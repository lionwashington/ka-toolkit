#!/bin/bash
# Creates a session, then uses inject-prompt.sh to send text; verifies the fake
# claude received it.
#
# bootstrap.sh is retired (canonical entry is `ka workshop`); this case only
# needs a live pane running the fake claude, so it creates the session directly
# with tmux — the same way 14/15 do.
set -euo pipefail

TMUX_BIN="${TMUX_BIN:-tmux}"
REPO="${REPO:-/repo}"

mkdir -p /tmp/proj-a
rm -f /tmp/claude-proj-a.log

# Fake `claude` (on PATH) reads stdin lines into /tmp/claude-<pwd-basename>.log
# → here /tmp/claude-proj-a.log.
"$TMUX_BIN" new-session -d -s testws -n team-lead -c /tmp/proj-a claude
sleep 2

# inject-prompt takes an explicit target pane (no auto-detect).
"$REPO/ops/lib/inject-prompt.sh" testws:0.0 "Run /daily-brief."
sleep 1

LOG=/tmp/claude-proj-a.log
grep -q "<<< Run /daily-brief." "$LOG" || { echo "FAIL: prompt not received"; cat "$LOG" 2>/dev/null; exit 1; }
echo "prompt delivered"
echo "03-inject-prompt OK"
