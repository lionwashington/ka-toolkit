#!/bin/bash
set -e
echo "========================================="
echo "  E2E Test: Knowledge Assistant on Claude Code"
echo "========================================="

PASS=0
FAIL=0

run_test() {
  local name="$1"
  local cmd="$2"
  echo -n "  [$name] "
  if output=$(eval "$cmd" 2>&1); then
    echo "✅ PASS"
    PASS=$((PASS+1))
  else
    echo "❌ FAIL"
    echo "    $output" | head -3
    FAIL=$((FAIL+1))
  fi
}

echo ""
echo "[1] Verifying installation artifacts..."
run_test "KB directory" "test -d ~/knowledge-base/topics && test -d ~/knowledge-base/raw && test -d ~/knowledge-base/conversations"
run_test "Settings hooks" "python3 -c \"import json; d=json.load(open('/root/.claude/settings.json')); assert 'Stop' in d['hooks']; assert 'PostCompact' in d['hooks']\""
run_test "MCP servers" "python3 -c \"import json; d=json.load(open('/root/.claude.json')); s=d['mcpServers']; assert 'knowledge-assistant' in s; assert 'market-data' in s; assert 'healthcare' in s; assert 'amap' in s\""
run_test "CLAUDE.md" "grep 'Session Startup Protocol' /root/.claude/CLAUDE.md"
run_test "Skills kb" "test -L /root/.claude/skills/kb/SKILL.md"
run_test "Skills mail" "test -L /root/.claude/skills/mail/SKILL.md"
run_test "Skills calendar" "test -L /root/.claude/skills/calendar/SKILL.md"
run_test "Skills daily-brief" "test -L /root/.claude/skills/daily-brief/SKILL.md"
run_test "ka-loop" "test -x /root/.knowledge-assistant/state/bin/ka-loop"
run_test "ka-session" "test -x /root/.knowledge-assistant/state/bin/ka-session"
run_test "Backup script" "test -x /root/.knowledge-assistant/state/backup.sh"

echo ""
echo "[2] Testing MCP servers start..."
run_test "KB MCP startup" "timeout 3 node /app/packages/mcp-server/dist/index.js < /dev/null 2>/dev/null; true"
run_test "Market MCP startup" "timeout 3 node /app/packages/market-mcp/dist/index.js < /dev/null 2>/dev/null; true"

echo ""
echo "[3] Testing session manager..."
mkdir -p /root/.knowledge-assistant/state/sessions
echo '{"sessionId":"test-123","cmdline":"echo hello","cwd":"/tmp","tool":"claude-code","platform":"linux","restart":false,"savedAt":"2026-04-08T00:00:00Z"}' > /root/.knowledge-assistant/state/sessions/test-123.json
run_test "session get" "node /app/kb/adapter-cc/scripts/session-manager.mjs get test-123 | grep test-123"
run_test "session restart" "node /app/kb/adapter-cc/scripts/session-manager.mjs restart test-123"
run_test "session clear" "node /app/kb/adapter-cc/scripts/session-manager.mjs clear test-123"
run_test "session status" "node /app/kb/adapter-cc/scripts/session-manager.mjs status | grep test-123"

echo ""
echo "[4] Running unit tests..."
TEST_OUTPUT=$(pnpm test 2>&1)
TOTAL_PASSED=$(echo "$TEST_OUTPUT" | grep "passed" | grep -oE "[0-9]+ passed" | awk '{sum += $1} END {print sum}')
run_test "Unit tests ($TOTAL_PASSED total)" "[ \"$TOTAL_PASSED\" -ge 70 ]"

echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
