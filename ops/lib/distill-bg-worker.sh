#!/bin/bash
# ops/lib/distill-bg-worker.sh — background worker spawned by distill-bg.sh.
#
# Responsibilities:
#   1. Run `claude -p` (headless Opus) cwd=workspace, instruct it to follow the
#      /kb distill --foreground workflow with the snapshot upper-bound.
#   2. After claude exits, run `ka-parse-distill-result` to reconcile stats
#      across multiple tiers (result-json → log-grep → mtime-scan → unknown).
#      The previous version only checked the claude .result field; when Opus
#      finished but emitted prose (empty .result), status stayed "running"
#      forever and burned cost on retries. See 2026-05-25/26 incident.
#   3. Write the final state to distill-current.json (status=done /
#      done-stats-unknown / failed). On failure it ALSO writes a standalone
#      sentinel (distill-last-failure.json) that the next run's "starting"
#      status does NOT overwrite, so a failure is never silently lost.
#
# Notification: the worker NEVER touches Telegram and holds no token. Telegram
# has a single egress — the main session. The main session reads the failure
# sentinel (acked:false) and notifies the user, then sets acked:true. See
# packages/skill/src/kb.md for the main-side read contract.

set -uo pipefail
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KA_REPO_ROOT="${KA_REPO_ROOT:-$(cd "$THIS_DIR/../.." && pwd)}"

JSONL=""
SESSION_ID=""
SNAPSHOT_OFFSET=""
SNAPSHOT_UUID=""
SNAPSHOT_COUNT=""
LOG_PATH=""
STATUS_FILE=""
WORKSPACE_CWD=""

# Model + retry tuning. The headless `claude -p` run below intermittently hits
# a CC 2.1.x bug — `400 ... thinking blocks ... cannot be modified` — when the
# model replays a history assistant turn containing extended-thinking blocks.
# It is non-deterministic, so a fresh re-spawn (we already pass
# --no-session-persistence) usually succeeds. Retry up to DISTILL_MAX_ATTEMPTS
# times with exponential backoff. All overridable via env so experiments (e.g.
# trying claude-opus-4-8, tuning attempts) need no code edit.
DISTILL_MODEL="${KA_DISTILL_MODEL:-claude-opus-4-8}"
DISTILL_MAX_ATTEMPTS="${KA_DISTILL_MAX_ATTEMPTS:-3}"
DISTILL_RETRY_BASE_SEC="${KA_DISTILL_RETRY_BASE_SEC:-5}"

while [ $# -gt 0 ]; do
    case "$1" in
        --jsonl)            JSONL="$2"; shift 2 ;;
        --session-id)       SESSION_ID="$2"; shift 2 ;;
        --snapshot-offset)  SNAPSHOT_OFFSET="$2"; shift 2 ;;
        --snapshot-uuid)    SNAPSHOT_UUID="$2"; shift 2 ;;
        --snapshot-count)   SNAPSHOT_COUNT="$2"; shift 2 ;;
        --log-path)         LOG_PATH="$2"; shift 2 ;;
        --status-file)      STATUS_FILE="$2"; shift 2 ;;
        --workspace-cwd)    WORKSPACE_CWD="$2"; shift 2 ;;
        *) echo "worker: unknown flag $1" >&2; exit 1 ;;
    esac
done

[ -n "$JSONL" ]            || { echo "worker: --jsonl required" >&2; exit 1; }
[ -n "$SESSION_ID" ]       || { echo "worker: --session-id required" >&2; exit 1; }
[ -n "$SNAPSHOT_OFFSET" ]  || { echo "worker: --snapshot-offset required" >&2; exit 1; }
[ -n "$LOG_PATH" ]         || { echo "worker: --log-path required" >&2; exit 1; }
[ -n "$STATUS_FILE" ]      || { echo "worker: --status-file required" >&2; exit 1; }
[ -n "$WORKSPACE_CWD" ]    || { echo "worker: --workspace-cwd required" >&2; exit 1; }

PARSER_CLI="$KA_REPO_ROOT/core-cli/distill-result-parser-cli.js"                       # runtime layout
[ -f "$PARSER_CLI" ] || PARSER_CLI="$KA_REPO_ROOT/packages/core/dist/distill-result-parser-cli.js"  # repo layout

# Stats file the distill agent Writes its result JSON to — the parser's tier-0
# (most reliable) source. Cleared up-front so we never read a previous run's file.
STATS_OUT="$(dirname "$STATUS_FILE")/distill-stats-${SESSION_ID}.json"
rm -f "$STATS_OUT"

# Merge a JSON patch into the status file. The patch must be a JSON object
# string (caller's responsibility to produce valid JSON — use the helper
# patch_status_with_parsed for the parser's structured output).
apply_status_patch() {
    local patch_json="$1"
    node -e '
const fs = require("fs");
const f = process.argv[1];
const patch = JSON.parse(process.argv[2]);
let j;
try { j = JSON.parse(fs.readFileSync(f, "utf-8")); } catch { j = {}; }
Object.assign(j, patch);
fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$STATUS_FILE" "$patch_json" || true
}

mark_failed() {
    local code="$1"
    local note="$2"
    local end_time tail_msg patch
    end_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    tail_msg="$(tail -n 5 "$LOG_PATH" 2>/dev/null | head -c 800 || true)"
    patch="$(node -e '
process.stdout.write(JSON.stringify({
  status: "failed",
  exit_code: Number(process.argv[1]),
  end_time: process.argv[2],
  parse_tier: null,
  parse_notes: process.argv[3],
}));
' "$code" "$end_time" "$note")"
    apply_status_patch "$patch"

    # Standalone failure sentinel. Unlike distill-current.json (which the next
    # run rewrites to status=starting), this file survives across runs so a
    # failure is never lost if the main session didn't read it in time.
    # acked:false is the watermark — the main session sets it true after it
    # notifies the user. The worker itself never touches Telegram.
    local failure_file
    failure_file="$(dirname "$STATUS_FILE")/distill-last-failure.json"
    node -e '
process.stdout.write(JSON.stringify({
  failed_at: process.argv[2],
  session_id: process.argv[3],
  exit_code: Number(process.argv[1]),
  attempts: Number(process.argv[7]),
  snapshot_offset: process.argv[8] === "" ? null : Number(process.argv[8]),
  reason: process.argv[4],
  error_excerpt: process.argv[5],
  log_path: process.argv[6],
  acked: false,
}, null, 2));
' "$code" "$end_time" "$SESSION_ID" "$note" "$tail_msg" "$LOG_PATH" "${attempt:-0}" "${SNAPSHOT_OFFSET:-}" \
        > "$failure_file" 2>/dev/null || true
    printf '[distill-worker] wrote failure sentinel %s (no telegram; main session notifies)\n' \
        "$failure_file" >> "$LOG_PATH"
}

# Returns 0 (retriable) if the given file holds a claude --output-format json
# result that is the intermittent CC headless "thinking block cannot be
# modified" 400. Such runs are safe to retry with a fresh --no-session
# spawn. Any other outcome (success, or a different error) returns non-zero.
is_retriable_thinking_error() {
    local out_file="$1"
    node -e '
const fs = require("fs");
let txt = "";
try { txt = fs.readFileSync(process.argv[1], "utf-8"); } catch { process.exit(1); }
// The result object may be preceded by other log lines; scan for the last
// JSON object whose type is "result".
let obj = null;
for (const line of txt.split("\n")) {
  const t = line.trim();
  if (!t.startsWith("{")) continue;
  try { const o = JSON.parse(t); if (o && o.type === "result") obj = o; } catch {}
}
if (!obj) process.exit(1);
const isErr = obj.is_error === true;
const is400 = obj.api_error_status === 400;
const result = typeof obj.result === "string" ? obj.result : "";
const thinking = /thinking|redacted_thinking/i.test(result);
process.exit(isErr && is400 && thinking ? 0 : 1);
' "$out_file"
}

# ---------- prompt construction ----------
# The distill agent runs in the workspace cwd, so the prompt must give it an
# ABSOLUTE path to the CLI (runtime/core-cli or repo/packages/core/dist).
JSONL_READER_ABS="$KA_REPO_ROOT/core-cli/jsonl-reader-cli.js"                       # runtime layout
[ -f "$JSONL_READER_ABS" ] || JSONL_READER_ABS="$KA_REPO_ROOT/packages/core/dist/jsonl-reader-cli.js"  # repo layout

# build_prompt <pass-upper-offset> → echoes the headless distill prompt for ONE
# pass whose upper bound is the given offset (= the full snapshot for a single
# pass, or a chunk boundary when a huge snapshot is split, see the chunk loop).
build_prompt() {
  local PASS_UPPER="$1"
  cat <<EOF
You are a background distiller worker. Run mode: headless Opus, no TTY interaction.

[Task]
Complete one incremental distill following the /kb distill --foreground workflow in packages/skill/src/kb.md.

[Snapshot constraints (race condition guard)]
- session_id: $SESSION_ID
- jsonl path: $JSONL
- snapshot upper-offset: $PASS_UPPER bytes (any jsonl content written after this byte MUST be ignored and left for the next distill)
- snapshot upper-entry-uuid: $SNAPSHOT_UUID
- message count known at snapshot time: $SNAPSHOT_COUNT

When calling ka-jsonl-reader you MUST pass:
  node $JSONL_READER_ABS \\
    --jsonl $JSONL \\
    [--offset <existing raw frontmatter's last_parsed_offset; omit on first run>] \\
    [--last-entry-uuid <existing last_parsed_message_id>] \\
    [--message-count <existing last_parsed_message_count>] \\
    --upper-offset $PASS_UPPER \\
    --batch <existing batch + 1, or 1 on first run>

[Steps]
1. Phase 0: locate the existing raw/<date>-<id>.md (match frontmatter by session_id), read its 4 last_parsed_* fields; if none exists, this is the first capture (omit --offset etc.)
2. Call ka-jsonl-reader with the command above to get markdownDelta + new progress
3. Append markdownDelta to the end of the raw file body; update the 4 frontmatter fields; keep distilled false
4. Phase 1: read the raw delta, match topics, append to conversations/<date>.md (TL;DR protocol) + run daily-log-splitter-cli to see if a split is needed + append to topics/<name>.md
5. **End of Phase 1**: markDistilled on every raw file you processed (set distilled: true + the topics array) — this step must NEVER be skipped, or the next run will treat them as un-distilled and reprocess them

[Output contract (mandatory — not following it = failure case)]

After you finish ALL distill work, you **MUST use the Write tool to write the following single-line stats JSON to this file** (overwrite; the entire file is just this one line of JSON — no code fence, no prose, no explanation):

  write path: ${STATS_OUT}
  write content (single line): {"raw_added": <int>, "conversations_updated": <int>, "topics_updated": <int>, "raw_files": ["..."], "conversations_files": ["..."], "topics_files": ["..."]}

Field meanings:
- raw_added: number of raw files this distill marked distilled:true (integer ≥0)
- conversations_updated: number of conversations/*.md files written or appended this run (including any split-out part2 / part3)
- topics_updated: number of topics/*.md files written or appended this run
- raw_files: array of processed raw file basenames (no path, e.g. ["2026-05-26-abc.md"])
- conversations_files: array of daily-log file basenames written or appended (including all parts after a split)
- topics_files: array of changed topic file basenames

**Why write a file instead of "saying it at the end"**: in headless mode you often finish with a tool call (markDistilled's Write/Edit), leaving claude's final message empty, so the reporter can't get exact numbers and has to degrade to guessing from file mtimes. Writing stats to the fixed file above is the most reliable — it doesn't depend on "what the last message was". Once you've written that file the distill is complete; earlier messages may contain prose diagnostics, but you do **not** need to repeat the JSON again.

If you hit an unrecoverable error, raise an exception (do NOT swallow it). The worker wrapper catches the non-zero exit and writes a failure sentinel (distill-last-failure.json), which the main session reads and then notifies the owner.
EOF
}

# run_distill_pass <pass-upper-offset> — one headless claude pass for
# [current frontmatter offset, pass-upper]. Retries the intermittent
# thinking-block 400. Sets EXIT_CODE; appends claude output to the run log.
run_distill_pass() {
    # NB: `attempt` is intentionally NOT local — mark_failed reports it in the
    # failure sentinel (attempts), so it must survive after this fn returns.
    local PASS_UPPER="$1" PROMPT CLAUDE_OUT backoff
    PROMPT="$(build_prompt "$PASS_UPPER")"
    EXIT_CODE=0
    attempt=0
    CLAUDE_OUT="$(mktemp "${TMPDIR:-/tmp}/distill-claude-out.XXXXXX")"
    while :; do
        attempt=$((attempt + 1))
        : > "$CLAUDE_OUT"
        set +e
        claude -p "$PROMPT" \
            --model "$DISTILL_MODEL" \
            --permission-mode bypassPermissions \
            --setting-sources user \
            --no-session-persistence \
            --output-format json \
            > "$CLAUDE_OUT" 2>> "$LOG_PATH"
        EXIT_CODE=$?
        set -e
        cat "$CLAUDE_OUT" >> "$LOG_PATH"
        if [ "$attempt" -lt "$DISTILL_MAX_ATTEMPTS" ] && is_retriable_thinking_error "$CLAUDE_OUT"; then
            backoff=$(( DISTILL_RETRY_BASE_SEC * (2 ** (attempt - 1)) ))
            printf '[distill-worker] attempt %d/%d hit intermittent thinking-block 400 (CC headless bug); retrying in %ds\n' \
                "$attempt" "$DISTILL_MAX_ATTEMPTS" "$backoff" >> "$LOG_PATH"
            sleep "$backoff"
            continue
        fi
        break
    done
    rm -f "$CLAUDE_OUT"
}

# read_cur_offset — the session's persisted last_parsed_offset (0 if no raw file
# yet / first distill). Used to chunk huge snapshots + verify per-pass progress.
# A session can have >1 raw file, and a raw body may quote another session's id,
# so we (1) match session_id ONLY in the YAML frontmatter (between the first two
# `---`), not the body, and (2) take the MAX last_parsed_offset across matches
# (the offset is monotonic, so the highest is the authoritative current state).
read_cur_offset() {
    local rawdir="$WORKSPACE_CWD/memory/raw" f fm off best=0
    [ -d "$rawdir" ] || { printf '0'; return; }
    for f in "$rawdir"/*.md; do
        [ -f "$f" ] || continue
        fm="$(awk '/^---$/{c++; next} c==1{print} c>=2{exit}' "$f" 2>/dev/null)"
        printf '%s\n' "$fm" | grep -qE "^session_id:[[:space:]]*$SESSION_ID[[:space:]]*\$" || continue
        off="$(printf '%s\n' "$fm" | sed -n 's/^last_parsed_offset:[[:space:]]*//p' | head -1 | tr -dc '0-9')"
        off="${off:-0}"
        [ "$off" -gt "$best" ] && best="$off"
    done
    printf '%s' "$best"
}

# ---------- run claude headless (chunked) ----------
# A huge first distill (offset 0 → tens of MB) loads the whole delta at once and
# gets OOM-killed. Split snapshots larger than CHUNK_BYTES into several passes,
# each a FRESH claude -p over [cur_offset, cur_offset+CHUNK] so peak memory stays
# bounded. A snapshot that fits in one chunk runs exactly as before (single pass).
CHUNK_BYTES="${KA_DISTILL_CHUNK_BYTES:-8388608}"   # 8 MiB per pass

START_TS="$(date -u +%s)"
START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '[distill-worker] start_iso=%s snapshot=%s session=%s\n' \
    "$START_ISO" "$SNAPSHOT_OFFSET" "$SESSION_ID" > "$LOG_PATH"

cd "$WORKSPACE_CWD" || { mark_failed 99 "chdir failed: $WORKSPACE_CWD"; exit 99; }

CUR_OFFSET="$(read_cur_offset)"
EXIT_CODE=0
if [ "$(( SNAPSHOT_OFFSET - CUR_OFFSET ))" -le "$CHUNK_BYTES" ]; then
    run_distill_pass "$SNAPSHOT_OFFSET"
    [ "$EXIT_CODE" -ne 0 ] && { mark_failed "$EXIT_CODE" "claude headless exited non-zero"; exit "$EXIT_CODE"; }
else
    pass=0
    while [ "$CUR_OFFSET" -lt "$SNAPSHOT_OFFSET" ]; do
        PASS_UPPER=$(( CUR_OFFSET + CHUNK_BYTES ))
        [ "$PASS_UPPER" -gt "$SNAPSHOT_OFFSET" ] && PASS_UPPER="$SNAPSHOT_OFFSET"
        pass=$(( pass + 1 ))
        printf '[distill-worker] pass %d: offset %d → %d (chunk≤%d, snapshot %d)\n' \
            "$pass" "$CUR_OFFSET" "$PASS_UPPER" "$CHUNK_BYTES" "$SNAPSHOT_OFFSET" >> "$LOG_PATH"
        run_distill_pass "$PASS_UPPER"
        [ "$EXIT_CODE" -ne 0 ] && { mark_failed "$EXIT_CODE" "claude headless exited non-zero on pass $pass (offset $CUR_OFFSET→$PASS_UPPER)"; exit "$EXIT_CODE"; }
        NEW_OFFSET="$(read_cur_offset)"
        if [ "$NEW_OFFSET" -le "$CUR_OFFSET" ]; then
            mark_failed 7 "distill pass $pass did not advance offset ($CUR_OFFSET → $NEW_OFFSET; expected ~$PASS_UPPER) — aborting to avoid an infinite loop"
            exit 7
        fi
        CUR_OFFSET="$NEW_OFFSET"
    done
    printf '[distill-worker] chunked done: %d pass(es), reached offset %d/%d\n' \
        "$pass" "$CUR_OFFSET" "$SNAPSHOT_OFFSET" >> "$LOG_PATH"
fi

END_TS="$(date -u +%s)"
END_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DURATION=$((END_TS - START_TS))
printf '[distill-worker] end_iso=%s exit=%d duration_sec=%d\n' \
    "$END_ISO" "$EXIT_CODE" "$DURATION" >> "$LOG_PATH"

# ---------- multi-tier parse ----------
[ -f "$PARSER_CLI" ] || { mark_failed 5 "parser CLI missing: $PARSER_CLI"; exit 5; }

# `|| true`: under `set -e` (enabled above), a non-zero node exit here — e.g.
# ERR_MODULE_NOT_FOUND from a missing bundled dep — would otherwise kill the
# worker silently, leaving status stuck at "running" with no failure sentinel.
# Letting it fall through to the empty-output check routes the crash to
# mark_failed instead.
PARSED_JSON="$(node "$PARSER_CLI" \
    --log-path "$LOG_PATH" \
    --memory-dir "$WORKSPACE_CWD/memory" \
    --start-time "$START_ISO" \
    --stats-file "$STATS_OUT" 2>>"$LOG_PATH")" || true

if [ -z "$PARSED_JSON" ]; then
    mark_failed 6 "parser CLI returned empty output (or crashed — see log)"
    exit 6
fi

printf '[distill-worker] parsed: %s\n' "$PARSED_JSON" >> "$LOG_PATH"

# Decide status from tier:
#   result-json / log-grep / mtime-scan → status=done
#   unknown                             → status=done-stats-unknown (still exit 0; not "failed")
TIER="$(node -e '
let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
  try { console.log(JSON.parse(d).tier); } catch { console.log("unknown"); }
})' <<<"$PARSED_JSON")"

if [ "$TIER" = "unknown" ]; then
    FINAL_STATUS="done-stats-unknown"
else
    FINAL_STATUS="done"
fi

# Merge parser result into status file.
PATCH_JSON="$(node -e '
let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
  const p = JSON.parse(d);
  const status = process.argv[1];
  const endIso = process.argv[2];
  const exitCode = Number(process.argv[3]);
  const duration = Number(process.argv[4]);
  process.stdout.write(JSON.stringify({
    status,
    end_time: endIso,
    exit_code: exitCode,
    duration_sec: duration,
    raw_added: p.rawAdded,
    conversations_updated: p.conversationsUpdated,
    topics_updated: p.topicsUpdated,
    raw_files: p.rawFiles,
    conversations_files: p.conversationsFiles,
    topics_files: p.topicsFiles,
    phase1_completed: p.phase1Completed,
    parse_tier: p.tier,
    parse_notes: p.notes,
  }));
})' "$FINAL_STATUS" "$END_ISO" "$EXIT_CODE" "$DURATION" <<<"$PARSED_JSON")"

apply_status_patch "$PATCH_JSON"

# Success summary — log only. Notification (if any) is the main session's job
# via distill-current.json; the worker holds no Telegram token.
RAW="$(node -e '
let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
  const p = JSON.parse(d);
  const fmt = v => (v === null || v === undefined) ? "?" : v;
  process.stdout.write([fmt(p.rawAdded), fmt(p.conversationsUpdated), fmt(p.topicsUpdated), p.tier, p.phase1Completed ? "yes" : "no"].join("|"));
})' <<<"$PARSED_JSON")"

RAW_ADDED="$(printf '%s' "$RAW" | cut -d'|' -f1)"
CONV_UPDATED="$(printf '%s' "$RAW" | cut -d'|' -f2)"
TOPICS_UPDATED="$(printf '%s' "$RAW" | cut -d'|' -f3)"
TIER_OUT="$(printf '%s' "$RAW" | cut -d'|' -f4)"
PHASE1="$(printf '%s' "$RAW" | cut -d'|' -f5)"

printf '[distill-worker] success status=%s raw=%s conv=%s topics=%s tier=%s phase1=%s\n' \
    "$FINAL_STATUS" "$RAW_ADDED" "$CONV_UPDATED" "$TOPICS_UPDATED" "$TIER_OUT" "$PHASE1" >> "$LOG_PATH"
