#!/bin/bash
# 23-distill-bg-retry.sh — verifies distill-bg-worker.sh
#   (1) retries the intermittent CC headless "thinking block cannot be
#       modified" 400 and gives up cleanly after the attempt cap, and
#   (2) on failure writes the standalone distill-last-failure.json sentinel
#       (with attempts/snapshot_offset/acked) and emits NO telegram activity.
# Uses a stateful fake claude (call counter in a temp file) to simulate the
# non-deterministic failure.
#
#   Case A: 1st call thinking-400, 2nd call succeeds  → status=done, retried
#   Case B: every call thinking-400                    → status=failed, capped
#   Case C: 1st call a NON-thinking error              → status=failed, no retry
#   Case D: failure sentinel shape + no-telegram       → distill-last-failure.json
set -euo pipefail

REPO="${REPO:-/repo}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAKE_BIN="$TMP/fakebin"
mkdir -p "$FAKE_BIN"
export PATH="$FAKE_BIN:$PATH"

WORKSPACE="$TMP/workspace"
mkdir -p "$WORKSPACE/memory/raw" "$WORKSPACE/memory/conversations" "$WORKSPACE/memory/topics"

JSONL="$TMP/fake.jsonl"
{
    printf '%s\n' '{"type":"user","uuid":"u1","timestamp":"2026-05-26T10:00:00Z","sessionId":"fake","isSidechain":false,"message":{"role":"user","content":"hello"}}'
    printf '%s\n' '{"type":"assistant","uuid":"a1","timestamp":"2026-05-26T10:00:01Z","sessionId":"fake","isSidechain":false,"message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}'
} > "$JSONL"

# Make retries instant so the suite stays fast, and cap attempts at 3.
export KA_DISTILL_RETRY_BASE_SEC=0
export KA_DISTILL_MAX_ATTEMPTS=3

COUNTER="$TMP/claude-calls"

reset_state() {
    local case_name="$1"
    HOME_BAK="$HOME"
    export HOME="$TMP/home-${case_name}"
    rm -rf "$HOME"
    mkdir -p "$HOME"
    rm -rf "$WORKSPACE/memory"
    mkdir -p "$WORKSPACE/memory/raw" "$WORKSPACE/memory/conversations" "$WORKSPACE/memory/topics"
    echo 0 > "$COUNTER"
}

restore_state() {
    export HOME="$HOME_BAK"
}

# Drive one spawn → wait for terminal status → echo "status|tier".
run_and_collect() {
    local case_name="$1"
    KA_HOME="$REPO" WORKSPACE_CWD="$WORKSPACE" \
        bash "$REPO/kb/ops/distill-bg.sh" --jsonl "$JSONL" --session-id "fake-${case_name}" \
        > /dev/null
    local state="$HOME/.knowledge-assistant/state/distill-current.json"
    for _ in $(seq 1 60); do
        s="$(awk -F'"' '/"status":/ {print $4; exit}' "$state" 2>/dev/null || true)"
        case "$s" in done|done-stats-unknown|failed) break ;; esac
        sleep 0.5
    done
    local final_status tier
    final_status="$(awk -F'"' '/"status":/ {print $4; exit}' "$state" 2>/dev/null || echo missing)"
    tier="$(awk -F'"' '/"parse_tier":/ {print $4; exit}' "$state" 2>/dev/null || echo missing)"
    echo "${final_status}|${tier}"
}

log_path_of() {
    local state="$HOME/.knowledge-assistant/state/distill-current.json"
    node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).log_path)' "$state"
}

# A 400 thinking-block error result (the bug we retry).
THINKING_400='node -e '\''process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:true,api_error_status:400,session_id:"fake",result:"API Error: 400 messages.1.content.13: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified."}))'\'

# ----- Case A: retry then succeed -----------------------------------------
reset_state "a-retry-success"
cat > "$FAKE_BIN/claude" <<EOFAKE
#!/bin/bash
c=\$(cat "$COUNTER"); c=\$((c+1)); echo \$c > "$COUNTER"
if [ "\$c" -lt 2 ]; then
  $THINKING_400
  exit 1
fi
node -e 'process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"fake",result:"{\"raw_added\":1,\"conversations_updated\":1,\"topics_updated\":1,\"raw_files\":[\"x.md\"],\"conversations_files\":[\"2026-05-26.md\"],\"topics_files\":[\"finance.md\"]}"}))'
exit 0
EOFAKE
chmod +x "$FAKE_BIN/claude"

out_a="$(run_and_collect "a-retry-success")"
calls_a="$(cat "$COUNTER")"
log_a="$(log_path_of)"
echo "Case A: $out_a (calls=$calls_a)"
[ "$out_a" = "done|result-json" ] || { echo "FAIL Case A status: got '$out_a'"; cat "$HOME/.knowledge-assistant/state/distill-current.json"; exit 1; }
[ "$calls_a" = "2" ] || { echo "FAIL Case A: expected 2 claude calls (1 retry), got $calls_a"; exit 1; }
grep -q "retrying" "$log_a" || { echo "FAIL Case A: no retry log line"; cat "$log_a"; exit 1; }
# Success must NOT write a failure sentinel.
[ ! -f "$HOME/.knowledge-assistant/state/distill-last-failure.json" ] || { echo "FAIL Case A: sentinel written on success"; exit 1; }
restore_state

# ----- Case B: exhaust retries → failed -----------------------------------
reset_state "b-exhaust"
cat > "$FAKE_BIN/claude" <<EOFAKE
#!/bin/bash
c=\$(cat "$COUNTER"); c=\$((c+1)); echo \$c > "$COUNTER"
$THINKING_400
exit 1
EOFAKE
chmod +x "$FAKE_BIN/claude"

out_b="$(run_and_collect "b-exhaust")"
calls_b="$(cat "$COUNTER")"
echo "Case B: $out_b (calls=$calls_b)"
[ "${out_b%%|*}" = "failed" ] || { echo "FAIL Case B: expected failed, got '$out_b'"; cat "$HOME/.knowledge-assistant/state/distill-current.json"; exit 1; }
[ "$calls_b" = "3" ] || { echo "FAIL Case B: expected 3 calls (attempt cap), got $calls_b"; exit 1; }
restore_state

# ----- Case C: non-thinking error → no retry ------------------------------
reset_state "c-no-retry"
cat > "$FAKE_BIN/claude" <<EOFAKE
#!/bin/bash
c=\$(cat "$COUNTER"); c=\$((c+1)); echo \$c > "$COUNTER"
node -e 'process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:true,api_error_status:500,session_id:"fake",result:"API Error: 500 internal server error"}))'
exit 1
EOFAKE
chmod +x "$FAKE_BIN/claude"

out_c="$(run_and_collect "c-no-retry")"
calls_c="$(cat "$COUNTER")"
echo "Case C: $out_c (calls=$calls_c)"
[ "${out_c%%|*}" = "failed" ] || { echo "FAIL Case C: expected failed, got '$out_c'"; cat "$HOME/.knowledge-assistant/state/distill-current.json"; exit 1; }
[ "$calls_c" = "1" ] || { echo "FAIL Case C: non-thinking error must NOT retry, expected 1 call, got $calls_c"; exit 1; }
restore_state

# ----- Case D: failure sentinel shape + no telegram -----------------------
# Reuse the exhaust scenario (3x thinking-400) so attempts should be 3.
reset_state "d-sentinel"
cat > "$FAKE_BIN/claude" <<EOFAKE
#!/bin/bash
c=\$(cat "$COUNTER"); c=\$((c+1)); echo \$c > "$COUNTER"
$THINKING_400
exit 1
EOFAKE
chmod +x "$FAKE_BIN/claude"

out_d="$(run_and_collect "d-sentinel")"
echo "Case D: $out_d"
[ "${out_d%%|*}" = "failed" ] || { echo "FAIL Case D: expected failed, got '$out_d'"; exit 1; }

SENTINEL="$HOME/.knowledge-assistant/state/distill-last-failure.json"
[ -f "$SENTINEL" ] || { echo "FAIL Case D: failure sentinel not written"; exit 1; }

# Validate sentinel fields: required keys present, acked:false, attempts==3,
# snapshot_offset numeric, error_excerpt mentions thinking.
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
const need = ["failed_at","session_id","exit_code","attempts","snapshot_offset","reason","error_excerpt","log_path","acked"];
for (const k of need) if (!(k in j)) { console.error("missing key: " + k); process.exit(1); }
if (j.acked !== false) { console.error("acked must be false, got " + j.acked); process.exit(1); }
if (j.attempts !== 3) { console.error("attempts expected 3, got " + j.attempts); process.exit(1); }
if (typeof j.snapshot_offset !== "number") { console.error("snapshot_offset must be numeric, got " + j.snapshot_offset); process.exit(1); }
if (!/thinking/i.test(j.error_excerpt)) { console.error("error_excerpt should mention thinking"); process.exit(1); }
' "$SENTINEL" || { echo "FAIL Case D: sentinel shape"; cat "$SENTINEL"; exit 1; }

# Worker must emit zero telegram PUSH activity. The only allowed mention is
# the informational sentinel line "(no telegram; main session notifies)";
# match the old push-behavior markers specifically, not the word "telegram".
log_d="$(log_path_of)"
if grep -qiE "api\.telegram\.org|sendMessage|bot token unavailable|skipping push|telegram-push" "$log_d"; then
    echo "FAIL Case D: worker log shows telegram push activity"; cat "$log_d"; exit 1
fi
echo "Case D: sentinel OK (attempts=3, acked=false), no telegram push in log"
restore_state

echo "PASS 23-distill-bg-retry (retry-success / exhaust / no-retry / sentinel)"
