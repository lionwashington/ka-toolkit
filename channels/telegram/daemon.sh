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
# Token: sourced from <deploy-dir>/.env (canonical: ~/.knowledge-assistant/runtime/daemon/.env) into the environment so the node
# process can read process.env.TELEGRAM_BOT_TOKEN. The token never leaves this
# process tree.
set -u
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # self-contained: dir of this script (canonical: ~/.knowledge-assistant/runtime/daemon)
LOCK="$ROOT/.daemon.lock"
ENV_FILE="$ROOT/.env"
# D0: runtime is a single self-contained esbuild bundle (channel-core kernel +
# telegram-platform + deps). No .ts source, no node_modules. Run it as ESM (.mjs).
BUNDLE="${KA_DAEMON_BUNDLE:-$ROOT/daemon.mjs}"

# Load the bot token (and any other secrets) into the environment.
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

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
