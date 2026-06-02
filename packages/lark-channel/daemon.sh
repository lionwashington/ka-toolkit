#!/bin/bash
# lark-channel daemon foreground runner (NEW: channel-core kernel + lark-platform,
# bundled). Run by start.sh (double-forks) or a cron supervisor. DO NOT run
# directly — use start.sh.
#
# Singleton: `flock -n` non-blocking when present (Linux); else the daemon enforces
# singleton by binding its fixed HTTP port (EADDRINUSE → clean exit).
#
# Config (self_open_id / groups / webhook_url) lives in <deploy-dir>/config.json;
# extra secrets (e.g. SELF_OPEN_ID) can go in <deploy-dir>/.env. lark-cli auth is
# handled lark-cli-side. The bundle is a self-contained .mjs (no .ts / node_modules).
set -u
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # canonical: ~/.knowledge-assistant/runtime/lark-daemon
LOCK="$ROOT/.daemon.lock"
ENV_FILE="$ROOT/.env"
BUNDLE="${KA_DAEMON_BUNDLE:-$ROOT/daemon.mjs}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

FLOCK_BIN="$(command -v flock || true)"
if [ -n "$FLOCK_BIN" ]; then
  exec "$FLOCK_BIN" -n -E 0 "$LOCK" node "$BUNDLE"
else
  exec node "$BUNDLE"
fi
