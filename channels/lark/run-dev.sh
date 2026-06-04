#!/bin/bash
# run-dev.sh — run the NEW LarkPlatform daemon (channel-core kernel + lark-platform)
# in SOURCE mode, foreground, for testing on a machine that has Lark + lark-cli.
#
# This is the dev/test runner. The bundled, install.sh-deployed, supervised daemon
# (runtime/lark-daemon, mirroring telegram) is a later phase (D0). For now: clone
# the repo, `pnpm install`, fill config.json, run this — Ctrl-C to stop.
#
# Data dir (config.json / state.json / channel.log / daemon.pid) = $KA_DAEMON_DATA_DIR
# (default ~/.lark-channel). See config.example.json + SETUP.md.
set -u
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # channels/lark
REPO="$(cd "$THIS_DIR/../.." && pwd)"

export KA_DAEMON_DATA_DIR="${KA_DAEMON_DATA_DIR:-$HOME/.lark-channel}"
export KA_PLATFORM_MODULE="$THIS_DIR/lark-platform.ts"

CONFIG="$KA_DAEMON_DATA_DIR/config.json"
if [ ! -f "$CONFIG" ]; then
  echo "ERROR: no config.json at $CONFIG"
  echo "  mkdir -p \"$KA_DAEMON_DATA_DIR\""
  echo "  cp \"$THIS_DIR/config.example.json\" \"$CONFIG\""
  echo "  then fill self_open_id / groups{chat_id:{webhook_url}} (see SETUP.md)."
  exit 1
fi

echo "lark daemon (LarkPlatform, source mode) — data=$KA_DAEMON_DATA_DIR"
echo "  kernel: channel-core/main.ts | platform: lark-platform.ts | port: from config.json (default 9876)"
exec node --experimental-strip-types "$REPO/channels/core/src/main.ts"
