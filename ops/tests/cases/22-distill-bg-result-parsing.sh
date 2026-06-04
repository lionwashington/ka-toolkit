#!/bin/bash
# Verifies distill-bg-worker.sh recovers from the 2026-05-25/26 incident where
# claude's `.result` field came back empty. Drives the worker through 4 tiers:
#   A. result-json     — claude emits valid stats JSON in .result
#   B. log-grep        — claude emits empty .result but stats JSON shows up
#                        elsewhere in the log
#   C. mtime-scan      — empty .result, no stats in log, but memory/*.md files
#                        were touched after start
#   D. done-stats-unknown — empty .result, nothing in log, nothing touched
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

reset_state() {
    local case_name="$1"
    HOME_BAK="$HOME"
    export HOME="$TMP/home-${case_name}"
    rm -rf "$HOME"
    mkdir -p "$HOME"
    rm -rf "$WORKSPACE/memory"
    mkdir -p "$WORKSPACE/memory/raw" "$WORKSPACE/memory/conversations" "$WORKSPACE/memory/topics"
}

restore_state() {
    export HOME="$HOME_BAK"
}

# Drive one spawn → wait → return "status|tier".
run_and_collect() {
    local case_name="$1"
    KA_REPO_ROOT="$REPO" WORKSPACE_CWD="$WORKSPACE" \
        bash "$REPO/ops/kb/distill-bg.sh" --jsonl "$JSONL" --session-id "fake-${case_name}" \
        > /dev/null
    local state="$HOME/.knowledge-assistant/state/distill-current.json"
    for _ in $(seq 1 30); do
        s="$(awk -F'"' '/"status":/ {print $4; exit}' "$state" 2>/dev/null || true)"
        case "$s" in done|done-stats-unknown|failed) break ;; esac
        sleep 0.5
    done
    local final_status tier
    final_status="$(awk -F'"' '/"status":/ {print $4; exit}' "$state" 2>/dev/null || echo missing)"
    tier="$(awk -F'"' '/"parse_tier":/ {print $4; exit}' "$state" 2>/dev/null || echo missing)"
    echo "${final_status}|${tier}"
}

# ----- Case A: result-json -------------------------------------------------
reset_state "a-result-json"
cat > "$FAKE_BIN/claude" <<EOFAKE
#!/bin/bash
node -e '
const result = "did the distill.\n{\"raw_added\": 1, \"conversations_updated\": 1, \"topics_updated\": 1, \"raw_files\": [\"x.md\"], \"conversations_files\": [\"2026-05-26.md\"], \"topics_files\": [\"finance.md\"]}";
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false,
  session_id: "fake", result,
}));
'
exit 0
EOFAKE
chmod +x "$FAKE_BIN/claude"

out_a="$(run_and_collect "a-result-json")"
echo "Case A: $out_a"
[ "$out_a" = "done|result-json" ] || { echo "FAIL Case A: got '$out_a'"; cat "$HOME/.knowledge-assistant/state/distill-current.json"; exit 1; }
restore_state

# ----- Case B: log-grep ----------------------------------------------------
reset_state "b-log-grep"
cat > "$FAKE_BIN/claude" <<'EOFAKE'
#!/bin/bash
# Emit a bare stats JSON line to stdout first (will land in the worker log),
# THEN the claude wrapper with an empty .result.
echo '{"raw_added": 9, "conversations_updated": 0, "topics_updated": 1}'
node -e '
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false,
  session_id: "fake", result: "",
}));
'
exit 0
EOFAKE
chmod +x "$FAKE_BIN/claude"

out_b="$(run_and_collect "b-log-grep")"
echo "Case B: $out_b"
[ "$out_b" = "done|log-grep" ] || { echo "FAIL Case B: got '$out_b'"; cat "$HOME/.knowledge-assistant/state/distill-current.json"; exit 1; }
restore_state

# ----- Case C: mtime-scan --------------------------------------------------
reset_state "c-mtime-scan"
cat > "$FAKE_BIN/claude" <<EOFAKE
#!/bin/bash
# Touch memory files (simulating distill side-effects), then emit empty result.
mkdir -p "$WORKSPACE/memory/raw" "$WORKSPACE/memory/conversations" "$WORKSPACE/memory/topics"
printf -- '---\nid: stub\ndistilled: true\n---\nbody\n' > "$WORKSPACE/memory/raw/2026-05-26-c.md"
echo "stub daily" > "$WORKSPACE/memory/conversations/2026-05-26.md"
echo "stub topic" > "$WORKSPACE/memory/topics/tech.md"
node -e '
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false,
  session_id: "fake", result: "no stats here, just prose.",
}));
'
exit 0
EOFAKE
chmod +x "$FAKE_BIN/claude"

out_c="$(run_and_collect "c-mtime-scan")"
echo "Case C: $out_c"
[ "$out_c" = "done|mtime-scan" ] || { echo "FAIL Case C: got '$out_c'"; cat "$HOME/.knowledge-assistant/state/distill-current.json"; exit 1; }
# Verify phase1_completed=true since raw file has distilled:true
phase1="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).phase1_completed)' "$HOME/.knowledge-assistant/state/distill-current.json")"
[ "$phase1" = "true" ] || { echo "FAIL Case C: phase1_completed expected true got '$phase1'"; cat "$HOME/.knowledge-assistant/state/distill-current.json"; exit 1; }
restore_state

# ----- Case D: done-stats-unknown ------------------------------------------
reset_state "d-unknown"
cat > "$FAKE_BIN/claude" <<'EOFAKE'
#!/bin/bash
node -e '
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false,
  session_id: "fake", result: "",
}));
'
exit 0
EOFAKE
chmod +x "$FAKE_BIN/claude"

out_d="$(run_and_collect "d-unknown")"
echo "Case D: $out_d"
[ "$out_d" = "done-stats-unknown|unknown" ] || { echo "FAIL Case D: got '$out_d'"; cat "$HOME/.knowledge-assistant/state/distill-current.json"; exit 1; }
restore_state

echo "OK 22-distill-bg-result-parsing"
