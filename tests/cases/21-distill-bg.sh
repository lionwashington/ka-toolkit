#!/bin/bash
# Verifies distill-bg.sh + distill-bg-worker.sh + distill-status.sh wire-up
# without invoking a real `claude` binary. Uses a fake claude in PATH to
# fabricate the worker's output, then asserts state-file transitions.
set -euo pipefail

REPO="${REPO:-/repo}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- Build a tiny fake jsonl --------------------------------------------------
JSONL="$TMP/fake.jsonl"
{
    printf '%s\n' '{"type":"user","uuid":"u1","timestamp":"2026-05-25T10:00:00Z","sessionId":"fake","isSidechain":false,"message":{"role":"user","content":"hello"}}'
    printf '%s\n' '{"type":"assistant","uuid":"a1","timestamp":"2026-05-25T10:00:01Z","sessionId":"fake","isSidechain":false,"message":{"role":"assistant","content":[{"type":"text","text":"hi back"}]}}'
} > "$JSONL"

# --- 1. Dry-run: snapshot capture + state file plan --------------------------
out="$(KA_HOME="$REPO" bash "$REPO/kb/ops/distill-bg.sh" --jsonl "$JSONL" --dry-run)"
echo "$out" | grep -q "session_id=fake"
echo "$out" | grep -q "snapshot.offset="
echo "$out" | grep -q "snapshot.count=2"

# --- 2. Distill-status with no state file ------------------------------------
HOME_BAK="$HOME"
export HOME="$TMP/home"
export KA_STATE_DIR="$HOME/.knowledge-assistant/state"
mkdir -p "$HOME"
status_empty="$(KA_HOME="$REPO" bash "$REPO/kb/ops/distill-status.sh")"
echo "$status_empty" | grep -q "no distill run recorded"

# --- 3. Full spawn with a fake claude that just emits the summary JSON -------
FAKE_BIN="$TMP/fakebin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/claude" <<'EOFAKE'
#!/bin/bash
# Mock claude --output-format json: emit a single JSON line containing
# `.result` with the expected last-line summary.
# Match the contract: result text ends with a single-line JSON summary.
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"fake","result":"did some distilling.\n{\"raw_added\": 1, \"conversations_updated\": 1, \"topics_updated\": 2}"}'
exit 0
EOFAKE
chmod +x "$FAKE_BIN/claude"

PATH_BAK="$PATH"
export PATH="$FAKE_BIN:$PATH"

# The worker chdir's to WORKSPACE_CWD; give it a real dir (else it falls back to
# the placeholder default and chdir fails). Same setup 22/23 use.
WORKSPACE="$TMP/workspace"
mkdir -p "$WORKSPACE/memory/raw" "$WORKSPACE/memory/conversations" "$WORKSPACE/memory/topics"

# Spawn (background); capture pid and wait for completion.
spawn_out="$(KA_HOME="$REPO" WORKSPACE_CWD="$WORKSPACE" bash "$REPO/kb/ops/distill-bg.sh" \
    --jsonl "$JSONL" \
    --session-id "fake-session")"
echo "$spawn_out" | grep -q "distill-bg: pid="
PID="$(printf '%s' "$spawn_out" | awk -F'[= ]' '{print $3}')"
LOG_PATH="$(printf '%s' "$spawn_out" | awk -F'log=' '{print $2}' | awk '{print $1}')"

# Wait up to 15s for status to flip away from "running".
for _ in $(seq 1 30); do
    status="$(awk -F'"' '/"status":/ {print $4; exit}' "$HOME/.knowledge-assistant/state/distill-current.json" 2>/dev/null || true)"
    [ "$status" = "done" ] && break
    [ "$status" = "failed" ] && break
    sleep 0.5
done

[ "$status" = "done" ] || { echo "FAIL: expected status=done, got '$status'"; cat "$LOG_PATH" 2>/dev/null || true; cat "$HOME/.knowledge-assistant/state/distill-current.json" 2>/dev/null || true; exit 1; }

# Verify the parsed numbers landed in the state file.
state_json="$HOME/.knowledge-assistant/state/distill-current.json"
grep -q '"raw_added": 1' "$state_json"
grep -q '"conversations_updated": 1' "$state_json"
grep -q '"topics_updated": 2' "$state_json"
grep -q '"exit_code": 0' "$state_json"

# Verify distill-status reports verdict=done
status_output="$(KA_HOME="$REPO" bash "$REPO/kb/ops/distill-status.sh")"
echo "$status_output" | grep -q "verdict.*done"
echo "$status_output" | grep -q "session_id .*fake-session"

# Cleanup
export PATH="$PATH_BAK"
export HOME="$HOME_BAK"

echo "OK 21-distill-bg"
