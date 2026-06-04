#!/bin/bash
# plist-gen.sh — generate a launchd plist for a ka cron job.
#
# Usage (env-driven, for determinism in tests):
#   KA_HOME=/path/to/repo \
#   KA_CRON_NAME=foo \
#   KA_CRON_SCHEDULE="daily 07:00" \
#   KA_CRON_LOG=/tmp/ka-cron/foo.log \
#   plist-gen.sh
#
# Stdout: complete plist XML (no trailing newline beyond the final </plist>).
#
# Label format: com.knowledge-assistant.ka.cron.<name>
# ProgramArguments: <repo>/ops/scripts/cron-run.sh <name>
# StartCalendarInterval is computed from KA_CRON_SCHEDULE via schedule-parser.sh.
# If the schedule produces one dict → emit <dict>…</dict>; multiple → emit
# <array>… </array>.
# Env (optional, KA_CRON_ENV="KEY1=VAL1;KEY2=VAL2") populates EnvironmentVariables.

set -euo pipefail

: "${KA_HOME:?KA_HOME required}"
: "${KA_CRON_NAME:?KA_CRON_NAME required}"
: "${KA_CRON_SCHEDULE:?KA_CRON_SCHEDULE required}"
: "${KA_CRON_LOG:?KA_CRON_LOG required}"

KA_CRON_ENV="${KA_CRON_ENV:-}"
LABEL="com.knowledge-assistant.ka.cron.${KA_CRON_NAME}"
RUNNER="${KA_HOME}/cron/ops/cron-run.sh"
PARSER="${KA_HOME}/cron/ops/internals/schedule-parser.sh"

[ -f "$PARSER" ] || { echo "plist-gen: missing $PARSER" >&2; exit 1; }

# Compute canonical dicts (one per line).
if ! DICTS="$(bash "$PARSER" "$KA_CRON_SCHEDULE")"; then
    echo "plist-gen: schedule-parser failed for '$KA_CRON_SCHEDULE'" >&2
    exit 1
fi

# Convert each canonical "Key=val;Key=val" line into a <dict> block.
render_dict_block() {
    local line="$1"
    local indent="$2"
    printf '%s<dict>\n' "$indent"
    local IFS=';'
    # shellcheck disable=SC2086
    set -- $line
    for kv in "$@"; do
        local k="${kv%%=*}"
        local v="${kv#*=}"
        printf '%s    <key>%s</key>\n%s    <integer>%s</integer>\n' \
            "$indent" "$k" "$indent" "$v"
    done
    printf '%s</dict>\n' "$indent"
}

# Count non-empty lines.
N=$(printf '%s\n' "$DICTS" | awk 'NF>0' | wc -l | tr -d ' ')

# Render env block (optional).
render_env() {
    [ -z "$KA_CRON_ENV" ] && return 0
    printf '    <key>EnvironmentVariables</key>\n    <dict>\n'
    local IFS=';'
    # shellcheck disable=SC2086
    set -- $KA_CRON_ENV
    for kv in "$@"; do
        [ -z "$kv" ] && continue
        local k="${kv%%=*}"
        local v="${kv#*=}"
        printf '        <key>%s</key>\n        <string>%s</string>\n' "$k" "$v"
    done
    printf '    </dict>\n'
}

cat <<HEADER
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${RUNNER}</string>
        <string>${KA_CRON_NAME}</string>
    </array>
HEADER

if [ "$N" -eq 1 ]; then
    printf '    <key>StartCalendarInterval</key>\n'
    line="$(printf '%s\n' "$DICTS" | awk 'NF>0' | head -1)"
    render_dict_block "$line" '    '
else
    printf '    <key>StartCalendarInterval</key>\n    <array>\n'
    printf '%s\n' "$DICTS" | awk 'NF>0' | while IFS= read -r line; do
        render_dict_block "$line" '        '
    done
    printf '    </array>\n'
fi

cat <<BODY
    <key>StandardOutPath</key>
    <string>${KA_CRON_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${KA_CRON_LOG}</string>
BODY

render_env

cat <<'FOOTER'
</dict>
</plist>
FOOTER
