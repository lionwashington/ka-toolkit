#!/bin/bash
# Verifies the worker chunks a large snapshot into multiple bounded claude passes
# (the distill-OOM fix). With KA_DISTILL_CHUNK_BYTES tiny, even a small snapshot
# is split; a mock claude advances the raw frontmatter's last_parsed_offset to
# each pass's upper bound, and the worker loops until it reaches the snapshot.
set -euo pipefail

REPO="${REPO:-/repo}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"; mkdir -p "$HOME"
WORKSPACE="$TMP/workspace"
mkdir -p "$WORKSPACE/memory/raw" "$WORKSPACE/memory/conversations" "$WORKSPACE/memory/topics"

# Regression guard for the multi-raw-file bug: a DECOY raw file that (a) sorts
# first alphabetically and (b) quotes our session id in its BODY but NOT its
# frontmatter. read_cur_offset must match session_id in the frontmatter only and
# ignore this file — else it picks the decoy (no last_parsed_offset → 0) and the
# advance check falsely aborts (the original exit-7 bug).
cat > "$WORKSPACE/memory/raw/00-decoy.md" <<'DECOY'
---
id: decoy
session_id: some-other-session-aaaa
distilled: true
---
A logged conversation that happens to quote: session_id: fake-chunk
(this must NOT be treated as the fake-chunk session's raw file)
DECOY

# Fake jsonl with a handful of messages so the snapshot offset is a few hundred
# bytes — comfortably larger than the tiny CHUNK below → forces multi-pass.
JSONL="$TMP/fake.jsonl"
: > "$JSONL"
for i in 1 2 3 4 5 6; do
    printf '%s\n' "{\"type\":\"user\",\"uuid\":\"u$i\",\"timestamp\":\"2026-05-26T10:00:0${i}Z\",\"sessionId\":\"fake\",\"isSidechain\":false,\"message\":{\"role\":\"user\",\"content\":\"message number $i with some padding text to add bytes\"}}" >> "$JSONL"
done

# Mock claude: parse the pass upper-offset + session_id from the prompt, write a
# raw file whose last_parsed_offset = that upper (simulating claude advancing the
# frontmatter), then emit the result JSON. cwd is the workspace (worker cd's there).
FAKE_BIN="$TMP/fakebin"; mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/claude" <<'EOFAKE'
#!/bin/bash
prompt=""; prev=""
for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
upper="$(printf '%s' "$prompt" | grep -oE 'snapshot upper-offset: [0-9]+' | grep -oE '[0-9]+' | head -1)"
sid="$(printf '%s' "$prompt" | grep -oE 'session_id: [A-Za-z0-9-]+' | awk '{print $2}' | head -1)"
rawdir="$PWD/memory/raw"; mkdir -p "$rawdir"
cat > "$rawdir/chunk-${sid}.md" <<RAW
---
session_id: ${sid}
last_parsed_offset: ${upper}
distilled: false
---
RAW
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"fake","result":"chunk done.\n{\"raw_added\":1,\"conversations_updated\":1,\"topics_updated\":1}"}'
exit 0
EOFAKE
chmod +x "$FAKE_BIN/claude"
export PATH="$FAKE_BIN:$PATH"

echo "[1/3] spawn distill with a tiny chunk size → multi-pass"
export KA_DISTILL_CHUNK_BYTES=100   # 100 bytes/pass → a few-hundred-byte snapshot splits
spawn="$(KA_REPO_ROOT="$REPO" WORKSPACE_CWD="$WORKSPACE" \
    bash "$REPO/kb/ops/distill-bg.sh" --jsonl "$JSONL" --session-id "fake-chunk")"
echo "$spawn" | grep -q "distill-bg: pid=" || { echo "FAIL: spawn"; echo "$spawn"; exit 1; }
LOG_PATH="$(printf '%s' "$spawn" | awk -F'log=' '{print $2}' | awk '{print $1}')"
state="$HOME/.knowledge-assistant/state/distill-current.json"
for _ in $(seq 1 40); do
    s="$(awk -F'"' '/"status":/ {print $4; exit}' "$state" 2>/dev/null || true)"
    case "$s" in done|done-stats-unknown|failed) break ;; esac
    sleep 0.5
done
echo "    status=$s"
echo "    ok"

echo "[2/3] the run log shows multiple chunk passes that reach the snapshot"
grep -qE 'pass 1: offset' "$LOG_PATH" || { echo "FAIL: no pass 1 in log"; cat "$LOG_PATH"; exit 1; }
grep -qE 'pass 2: offset' "$LOG_PATH" || { echo "FAIL: expected ≥2 passes (multi-pass not triggered)"; cat "$LOG_PATH"; exit 1; }
grep -qE 'chunked done: [0-9]+ pass' "$LOG_PATH" || { echo "FAIL: chunk loop did not complete"; cat "$LOG_PATH"; exit 1; }
echo "    $(grep -oE 'chunked done: [0-9]+ pass\(es\), reached offset [0-9]+/[0-9]+' "$LOG_PATH" | tail -1)"
echo "    ok"

echo "[3/3] reached offset == snapshot offset (fully processed) + status not failed"
line="$(grep -oE 'reached offset [0-9]+/[0-9]+' "$LOG_PATH" | tail -1)"
reached="$(printf '%s' "$line" | grep -oE '[0-9]+/[0-9]+' | cut -d/ -f1)"
snap="$(printf '%s' "$line" | grep -oE '[0-9]+/[0-9]+' | cut -d/ -f2)"
[ -n "$reached" ] && [ "$reached" = "$snap" ] || { echo "FAIL: did not reach snapshot ($line)"; exit 1; }
[ "$s" != "failed" ] || { echo "FAIL: status=failed"; cat "$state"; exit 1; }
echo "    ok ($line)"

echo "28-distill-chunk OK"
