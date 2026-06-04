#!/usr/bin/env bash
# Fake lark-cli for e2e tests. Handles the two subcommands the daemon invokes:
#
#   im +chat-messages-list --chat-id <id> --page-size <n> --format json
#     → emit the canned JSON at $LARK_MOCK_DIR/<chat-id>.json (shape
#       {ok,data:{messages}}), or an empty-messages response if none queued.
#
#   im +messages-resources-download --message-id <mid> --type <t> --file-key <k>
#                                   --output <name> --as user
#     → write a small dummy file at <cwd>/<name> (cwd is the daemon's attachments/
#       dir) and report {"ok":true,"data":{"saved_path":"<abs path>"}} like lark-cli.
set -u
sub=""
chat=""
output=""
while [ $# -gt 0 ]; do
  case "$1" in
    +chat-messages-list)          sub="list" ;;
    +messages-resources-download) sub="download" ;;
    --chat-id) chat="${2:-}"; shift ;;
    --output)  output="${2:-}"; shift ;;
  esac
  shift
done

if [ "$sub" = "download" ]; then
  name="${output:-att.bin}"
  printf 'fake attachment bytes' > "$name" 2>/dev/null || true
  printf '{"ok":true,"data":{"saved_path":"%s/%s"}}' "$PWD" "$name"
  exit 0
fi

# default: chat-messages-list
f="${LARK_MOCK_DIR:-/nonexistent}/${chat}.json"
if [ -f "$f" ]; then
  cat "$f"
else
  printf '{"ok":true,"data":{"messages":[]}}'
fi
