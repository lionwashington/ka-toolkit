#!/bin/bash
# kb-retrieval daemon foreground runner.
#
# Run by start.sh (which double-forks it). DO NOT run directly — use start.sh.
#
# Singleton: `flock -n` non-blocking on Linux; on macOS (no flock) the daemon
# itself enforces singleton by binding the fixed HTTP port (EADDRINUSE → clean
# exit 0). The daemon reads config.yaml (retrieval.daemon.port + knowledge_base_path)
# from $KA_HOME/config.
#
# cwd = this dir (the deploy dir $KA_HOME/kb/mcp/kb): the embedding model cache
# lives at ./local_cache, and node resolves dist/daemon.js + the adjacent
# node_modules (native @lancedb/lancedb + fastembed/onnxruntime) from here.
set -u
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # $KA_HOME/kb/mcp/kb
LOCK="$ROOT/.daemon.lock"
# kb/mcp/kb → ../../.. = KA_HOME. Export so the daemon resolves $KA_HOME/config.
: "${KA_HOME:=$(cd "$ROOT/../../.." && pwd)}"
export KA_HOME
cd "$ROOT"   # fastembed model cache (./local_cache) + node_modules resolve from here

ENTRY="${KA_KB_DAEMON_ENTRY:-$ROOT/dist/daemon.mjs}"
# gen3 config lives at $KA_HOME/config/config.yaml (KA_CONFIG_DIR), NOT the
# @ka/core loadConfig default (~/.knowledge-assistant/config.yaml). Pass it
# explicitly so the daemon reads the same config as the rest of gen3.
CONFIG_YAML="${KA_CONFIG:-${KA_CONFIG_DIR:-$KA_HOME/config}/config.yaml}"

FLOCK_BIN="$(command -v flock || true)"
if [ -n "$FLOCK_BIN" ]; then
  exec "$FLOCK_BIN" -n -E 0 "$LOCK" node "$ENTRY" "$CONFIG_YAML"
else
  exec node "$ENTRY" "$CONFIG_YAML"
fi
