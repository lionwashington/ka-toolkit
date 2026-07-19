#!/usr/bin/env bash
# Fake lark-cli for e2e tests. Handles polling, downloads, and raw CardKit APIs.
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
method=""
path=""
data=""
while [ $# -gt 0 ]; do
  case "$1" in
    api)                          sub="api" ;;
    POST|PUT|PATCH)               [ "$sub" = "api" ] && [ -z "$method" ] && method="$1" ;;
    /open-apis/*)                 [ "$sub" = "api" ] && path="$1" ;;
    +chat-messages-list)          sub="list" ;;
    +messages-resources-download) sub="download" ;;
    --chat-id) chat="${2:-}"; shift ;;
    --output)  output="${2:-}"; shift ;;
    --data)    data="${2:-}"; shift ;;
  esac
  shift
done

if [ "$sub" = "api" ]; then
  printf '%s\t%s\t%s\n' "$method" "$path" "$data" >> "${LARK_MOCK_DIR:-/tmp}/api-calls.tsv"
  if [ "$method" = "POST" ] && [ "$path" = "/open-apis/cardkit/v1/cards" ]; then
    if [ "${LARK_MOCK_CARDKIT_FAIL:-0}" = "1" ]; then
      printf '{"ok":false,"error":{"code":99991672,"message":"missing card scope"}}' >&2
      exit 1
    fi
    printf '{"ok":true,"data":{"card_id":"card-1"}}'
  elif [ "$method" = "POST" ] && [ "$path" = "/open-apis/im/v1/messages" ]; then
    printf '{"ok":true,"data":{"message_id":"om_test"}}'
  else
    printf '{"ok":true,"data":{}}'
  fi
  exit 0
fi

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
