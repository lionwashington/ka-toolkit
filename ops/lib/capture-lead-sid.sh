#!/bin/bash
# capture-lead-sid.sh — pin lead's actual session id to disk so subsequent
# `ka start` reliably resumes the SAME lead session, immune to mate jsonl
# pollution from CC 2.1.126's Agent-tool cwd-inheritance bug (mates inherit
# lead cwd, so their jsonls land in lead's project dir).
#
# Usage: capture-lead-sid.sh <lead-cwd>
#
# Caller MUST invoke this AFTER `wait-ready.sh` confirms lead is ready AND
# BEFORE any mate spawns. At that moment lead is the only writer in its
# project dir, so "newest jsonl" unambiguously identifies lead's session.
#
# Behavior:
#   - If pin file already valid (sid points to existing jsonl), skip — no
#     overwrite. Protects against re-runs where mate jsonls have since
#     become newest.
#   - Otherwise, capture newest jsonl in proj_dir as lead's sid.
#   - Refuse to pin a jsonl whose first user message starts with
#     `<teammate-message` — that's a polluted mate session, NOT lead's.
#
# See memory/topics/tools.md "CC 2.1.126 Agent-tool cwd 继承 bug 仍未修".
set -euo pipefail

LEAD_CWD="${1:?lead cwd required}"
PIN_DIR="${KA_STATE_DIR:-$HOME/.knowledge-assistant/state}"
PIN_FILE="$PIN_DIR/lead-session.id"

# CC encodes /path/to/dir as -path-to-dir under ~/.claude/projects/.
proj_name="$(printf '%s' "$LEAD_CWD" | tr '/' '-')"
proj_dir="$HOME/.claude/projects/$proj_name"

if [ ! -d "$proj_dir" ]; then
    echo "[capture-lead-sid] no project dir: $proj_dir (lead may not have written yet)" >&2
    exit 1
fi

# If existing pin is still valid, don't overwrite — protects against re-runs
# where mate jsonls have since become newest in proj_dir.
if [ -f "$PIN_FILE" ]; then
    existing="$(tr -d '[:space:]' < "$PIN_FILE" 2>/dev/null || true)"
    if [ -n "$existing" ] && [ -f "$proj_dir/$existing.jsonl" ]; then
        echo "[capture-lead-sid] pin already valid: $existing (skipping)"
        exit 0
    fi
fi

# Walk jsonls newest-first and pick the first whose first user message is
# NOT `<teammate-message` (= mate). Why a walk, not just "newest":
#
# Empirically (5/4 21:03 boot RCA), at the moment we run, several mate
# jsonls written under THIS proj_dir (CC 2.1.126 cwd-inheritance bug) can
# have an mtime equal to or fresher than lead's own jsonl — CC's async
# IO + simultaneous writes from mates spawned during the same `ka start`
# don't preserve "lead writes first" ordering at the filesystem-mtime
# level. Old leftover mate jsonls from prior boots are also pinned to the
# wrong proj_dir for the same reason. A naive `ls -t | head -1` therefore
# loses the race in real workshops.
#
# Lead detection: lead's jsonl either has no `type:user` rows yet (CC
# hasn't received any prompt — empty first_user_msg, NOT a `<teammate-`
# prefix), or its first user msg is something else (SessionStart hook
# output, user typing, slash command). Mate jsonls always start with
# `<teammate-message` because that's the SendMessage wrapper format.
# Use a while-loop instead of `mapfile` — macOS ships bash 3.2 which lacks
# mapfile (bash 4+ builtin). Process substitution + IFS= read is portable.
jsonls=()
while IFS= read -r f; do
    jsonls+=("$f")
done < <(ls -t "$proj_dir"/*.jsonl 2>/dev/null)
if [ "${#jsonls[@]}" -eq 0 ]; then
    echo "[capture-lead-sid] no jsonl in $proj_dir" >&2
    exit 1
fi

latest=""
skipped=0
for candidate in "${jsonls[@]}"; do
    first_user_msg="$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    for line in f:
        d = json.loads(line)
        if d.get('type') == 'user':
            msg = d.get('message', {})
            content = msg.get('content', '') if isinstance(msg, dict) else ''
            if isinstance(content, str):
                print(content[:64])
            break
" "$candidate" 2>/dev/null || true)"
    case "$first_user_msg" in
        "<teammate-message"*)
            skipped=$((skipped + 1))
            continue
            ;;
    esac
    latest="$candidate"
    break
done

if [ -z "$latest" ]; then
    echo "[capture-lead-sid] ERROR: no non-mate jsonl in $proj_dir (scanned ${#jsonls[@]} files, all start with <teammate-message)" >&2
    echo "[capture-lead-sid] lead jsonl probably hasn't been created yet; retry on next ka start" >&2
    exit 2
fi

if [ "$skipped" -gt 0 ]; then
    echo "[capture-lead-sid] skipped $skipped mate jsonl(s) before finding lead candidate" >&2
fi

sid="$(basename "$latest" .jsonl)"
mkdir -p "$PIN_DIR"
printf '%s\n' "$sid" > "$PIN_FILE"
echo "[capture-lead-sid] pinned $sid → $PIN_FILE"
