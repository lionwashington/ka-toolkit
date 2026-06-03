#!/bin/bash
# ops/cli/distill-status.sh — print the current state of the background
# distill worker (~/.knowledge-assistant/state/distill-current.json) plus a
# health verdict (running vs. dead).
#
# Usage:
#   ka distill status [--json]

set -euo pipefail
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$THIS_DIR/common.sh"

STATUS_FILE="$HOME/.knowledge-assistant/state/distill-current.json"
EMIT_JSON=0

while [ $# -gt 0 ]; do
    case "$1" in
        --json) EMIT_JSON=1; shift ;;
        -h|--help)
            cat <<EOF
ka distill status — show last/current background distill run

USAGE
    ka distill status [--json]

FLAGS
    --json   Print raw JSON instead of human-readable summary.
EOF
            exit 0
            ;;
        *) log_err "unknown flag: $1"; exit 1 ;;
    esac
done

if [ ! -f "$STATUS_FILE" ]; then
    echo "no distill run recorded yet ($STATUS_FILE missing)"
    exit 0
fi

if [ "$EMIT_JSON" -eq 1 ]; then
    cat "$STATUS_FILE"
    exit 0
fi

node -e '
const fs = require("fs");
const f = process.argv[1];
const j = JSON.parse(fs.readFileSync(f, "utf-8"));

const fmt = (k, v) => `  ${k.padEnd(22)} ${v ?? "(null)"}`;
const isAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

let verdict;
if (j.status === "running") {
  verdict = isAlive(j.pid) ? "running" : "running-but-pid-dead (likely crashed)";
} else {
  verdict = j.status ?? "(unknown)";
}

console.log("distill-current.json:");
console.log(fmt("verdict",          verdict));
console.log(fmt("pid",              j.pid));
console.log(fmt("status",           j.status));
console.log(fmt("session_id",       j.session_id));
console.log(fmt("start_time",       j.start_time));
console.log(fmt("end_time",         j.end_time));
console.log(fmt("snapshot_offset",  j.snapshot_offset));
console.log(fmt("snapshot_count",   j.snapshot_count));
console.log(fmt("raw_added",        j.raw_added));
console.log(fmt("conversations_updated", j.conversations_updated));
console.log(fmt("topics_updated",   j.topics_updated));
console.log(fmt("exit_code",        j.exit_code));
console.log(fmt("log_path",         j.log_path));
' "$STATUS_FILE"
