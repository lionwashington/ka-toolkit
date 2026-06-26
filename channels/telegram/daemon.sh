#!/bin/bash
# telegram-channel daemon foreground runner.
#
# This is run by start.sh (which double-forks it) or by a cron supervisor.
# DO NOT run this directly — use start.sh instead (handles backgrounding).
#
# Singleton: `flock -n` non-blocking — if another daemon holds the lock,
# we exit cleanly (return code 0) instead of erroring. That way concurrent
# `start.sh` invocations don't print errors.
#
# Config/secrets: the daemon reads config.yaml (port/poll) + secrets.yaml (bot
# token / owner_chat_id) from $KA_HOME/config — resolved below and exported so
# the node process finds them. The token never leaves this process tree.
set -u
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"  # launchd/cron PATH lacks Homebrew/nvm → else `node: not found` on keepalive cold-start

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # self-contained: dir of this script (canonical: ~/.knowledge-assistant/channels/telegram-daemon)
LOCK="$ROOT/.daemon.lock"
# Single root: this dir is $KA_HOME/channels/telegram-daemon, so ../.. = KA_HOME.
# Export it (unless already set) so the daemon resolves $KA_HOME/config the same
# way common.sh does. KA_DAEMON_DATA_DIR (state/log/pid) stays = this dir.
: "${KA_HOME:=$(cd "$ROOT/../.." && pwd)}"
export KA_HOME
# D0: runtime is a single self-contained esbuild bundle (channel-core kernel +
# telegram-platform + deps). No .ts source, no node_modules. Run it as ESM (.mjs).
BUNDLE="${KA_DAEMON_BUNDLE:-$ROOT/daemon.mjs}"

# Singleton: prefer `flock` when present (Linux). macOS has no flock binary, so
# fall back to running node directly — the daemon enforces singleton by binding
# the fixed HTTP port (EADDRINUSE → clean exit). flock -n -E 0: nonblocking,
# exit code 0 (not 1) if the lock is held by someone else.
FLOCK_BIN="$(command -v flock || true)"
if [ -n "$FLOCK_BIN" ]; then
  exec "$FLOCK_BIN" -n -E 0 "$LOCK" node "$BUNDLE"
else
  exec node "$BUNDLE"
fi
