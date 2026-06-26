#!/bin/bash
# lark-channel daemon foreground runner (NEW: channel-core kernel + lark-platform,
# bundled). Run by start.sh (double-forks) or a cron supervisor. DO NOT run
# directly — use start.sh.
#
# Singleton: `flock -n` non-blocking when present (Linux); else the daemon enforces
# singleton by binding its fixed HTTP port (EADDRINUSE → clean exit).
#
# Config (port/poll) lives in $KA_HOME/config/config.yaml channels.lark; secrets
# (self_open_id / groups / webhook_url) in $KA_HOME/config/secrets.yaml. lark-cli
# auth is handled lark-cli-side. The bundle is a self-contained .mjs (no .ts).
set -u
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"  # launchd/cron PATH lacks Homebrew/nvm → else `node: not found` on keepalive cold-start

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # canonical: ~/.knowledge-assistant/channels/lark-daemon
LOCK="$ROOT/.daemon.lock"
# Single root: this dir is $KA_HOME/channels/lark-daemon, so ../.. = KA_HOME.
# Export it (unless already set) so the daemon resolves $KA_HOME/config.
: "${KA_HOME:=$(cd "$ROOT/../.." && pwd)}"
export KA_HOME
BUNDLE="${KA_DAEMON_BUNDLE:-$ROOT/daemon.mjs}"

FLOCK_BIN="$(command -v flock || true)"
if [ -n "$FLOCK_BIN" ]; then
  exec "$FLOCK_BIN" -n -E 0 "$LOCK" node "$BUNDLE"
else
  exec node "$BUNDLE"
fi
