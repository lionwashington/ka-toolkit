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
# launchd / cron invoke this with a MINIMAL PATH (/usr/bin:/bin:/usr/sbin:/sbin) that
# lacks Homebrew (/opt/homebrew/bin on arm, /usr/local/bin on intel) and nvm — so the
# `exec node` below dies "node: not found" and a keepalive can NEVER cold-start the
# daemon (kb_search stayed offline 2026-06-22→26 exactly here). Source nvm + prepend
# the common node install dirs so node resolves however it was installed.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # $KA_HOME/kb/mcp/kb
LOCK="$ROOT/.daemon.lock"
# kb/mcp/kb → ../../.. = KA_HOME. Export so the daemon resolves $KA_HOME/config.
: "${KA_HOME:=$(cd "$ROOT/../../.." && pwd)}"
export KA_HOME
cd "$ROOT"   # node_modules (native @lancedb/fastembed) resolve from here
# Point the embedder at the cache shipped alongside this deploy (install put the
# fastembed model under $ROOT/local_cache). Explicit so it doesn't fall back to the
# dev default ~/.cache/ka-toolkit/fastembed (which the runtime may not have).
export KA_EMBED_CACHE_DIR="${KA_EMBED_CACHE_DIR:-$ROOT/local_cache}"
# Keep MLE5Large document batches small on the supported low-memory host. The
# TypeScript embedder has the same default; exporting it here makes the runtime
# policy explicit and lets operators opt upward on larger machines.
export KA_EMBED_BATCH_SIZE="${KA_EMBED_BATCH_SIZE:-4}"

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
