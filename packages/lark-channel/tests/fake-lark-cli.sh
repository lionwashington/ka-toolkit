#!/usr/bin/env bash
# Fake lark-cli for e2e tests. The daemon invokes it as:
#   <bin> im +chat-messages-list --chat-id <id> --page-size <n> --format json
# We ignore everything except --chat-id and emit the canned JSON response at
# $LARK_MOCK_DIR/<chat-id>.json (the lark-cli shape {ok,data:{data:{messages}}}),
# or an empty-messages response when the test hasn't queued anything for that chat.
set -u
chat=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--chat-id" ]; then chat="${2:-}"; shift; fi
  shift
done
f="${LARK_MOCK_DIR:-/nonexistent}/${chat}.json"
if [ -f "$f" ]; then
  cat "$f"
else
  printf '{"ok":true,"data":{"messages":[]}}'
fi
