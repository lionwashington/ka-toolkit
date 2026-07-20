#!/usr/bin/env bash
# install.sh — KA unified install/deploy entry point (ka-gen2 P1: unified deploy model).
#
# Builds + copies the repo (design-time source) to the runtime location, drawing a
# clear design↔runtime boundary. Single-copy model (decision D4): what runs is the
# deployed copy, not the repo; re-run `ka deploy` to pick up dev changes.
#
# 🔴 Top red line (must not affect existing usage):
#   - Operates on ~/.knowledge-assistant by default, but offers a KA_HOME
#     override for isolated tests (point it at a temp dir).
#   - The steps that actually "switch what's running" (register_mcp editing
#     ~/.claude.json, moving the daemon) default to **SKIP**; they require an
#     explicit --switch and must be run by the owner — a plain install NEVER
#     touches your running ~/.claude.json / daemon.
#   - seed_config never overwrites existing config/credentials.
#
# Usage:
#   ./install.sh [--dry-run] [--only ka|node-mcp|python-mcp|daemon|hooks|core-cli|skills|config] [--switch]
#   KA_HOME=/tmp/ka-itest ./install.sh --dry-run    # isolated test, doesn't touch the real runtime
#
# Status: P1.1 skeleton — each component's deploy function is filled in over P1.2–P1.5.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KA_HOME="${KA_HOME:-$HOME/.knowledge-assistant}"
RUNTIME="$KA_HOME"          # root of KA deploy artifacts (ka / ops / mcp / daemon / hooks)

# ── Switch-target overrides (point at a temp fake-home in isolated tests; never touch real files) ──
# The --switch steps edit these "pointer" files; in tests, override them all to a temp dir for zero-risk verification.
CLAUDE_JSON="${KA_CLAUDE_JSON:-$HOME/.claude.json}"                   # node MCP registration
KA_BIN_LINK="${KA_BIN_LINK:-$HOME/.local/bin/ka}"                     # ka command symlink
LAUNCHAGENTS_DIR="${KA_LAUNCHAGENTS:-$HOME/Library/LaunchAgents}"     # cron plist
CLAUDE_SETTINGS="${KA_CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"  # hooks registration
CODEX_HOOKS="${KA_CODEX_HOOKS:-${CODEX_HOME:-$HOME/.codex}/hooks.json}" # Codex lifecycle hooks
CLAUDE_SKILLS_DIR="${KA_CLAUDE_SKILLS:-$HOME/.claude/skills}"         # skills symlink landing spot
TELEGRAM_DIR="${KA_TELEGRAM_DIR:-$HOME/.telegram-channel}"            # old daemon location
LARK_DIR="${KA_LARK_DIR:-$HOME/.lark-channel}"                        # old lark daemon location
# The active channel daemon (telegram|lark) is chosen via `--channel-kind` and
# persisted to config.yaml `channel_kind` (see resolve_active_kind below). Both
# daemons are always deployed; only the active one is started.

DRY_RUN=0; ONLY=""; DO_SWITCH=0; DO_CLEANUP=0; CHANNEL_KIND_ARG=""
usage() {
  cat <<'EOF'
Usage: ./install.sh [options]
  --dry-run                  Print actions without changing runtime files
  --only <component>         Deploy one component
  --switch                   Switch live registrations after deployment
  --cleanup-old              Remove obsolete deployed artifacts
  --channel-kind <kind>      Select telegram or lark
  -h, --help                 Show this help and exit
EOF
}
for a in "$@"; do
  case "$a" in
    -h|--help) usage; exit 0 ;;
    --dry-run)  DRY_RUN=1 ;;
    --switch)   DO_SWITCH=1 ;;
    --cleanup-old) DO_CLEANUP=1 ;;
    --only=*)   ONLY="${a#--only=}" ;;
    --only)     : ;;  # tolerate space form below
    --channel-kind=*) CHANNEL_KIND_ARG="${a#--channel-kind=}" ;;
    --channel-kind)   : ;;  # tolerate space form below
    *) [ "${prev:-}" = "--only" ] && ONLY="$a"
       [ "${prev:-}" = "--channel-kind" ] && CHANNEL_KIND_ARG="$a" ;;
  esac
  prev="$a"
done

log()  { echo "[install] $*"; }
run()  { if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

# ── Active channel daemon kind (single source of truth = config.yaml) ────────
# BOTH daemons (telegram + lark) are ALWAYS deployed; only the ACTIVE kind is
# started, and that kind is persisted to config.yaml `channel_kind` so every
# runtime ka command reads it from there (no env knob). Resolution precedence:
#   --channel-kind arg  >  existing config.yaml  >  interactive prompt  >  telegram
# (The legacy KA_CHANNEL selector is retired — KA_CHANNEL now means only a
# workshop channel NAME, never the daemon selector.)
CONFIG_YAML="$KA_HOME/config/config.yaml"
_cfg_channel_kind() {
  [ -f "$CONFIG_YAML" ] || return 0
  sed -n 's/^[[:space:]]*channel_kind[[:space:]]*:[[:space:]]*//p' "$CONFIG_YAML" \
    | head -1 | sed 's/[[:space:]]*$//; s/^"//; s/"$//' | sed "s/^'//; s/'\$//"
}
ACTIVE_KIND=""
resolve_active_kind() {
  local k=""
  if [ -n "$CHANNEL_KIND_ARG" ]; then
    k="$CHANNEL_KIND_ARG"; log "channel-kind from --channel-kind: ${k}"
  elif [ -n "$(_cfg_channel_kind)" ]; then
    k="$(_cfg_channel_kind)"; log "channel-kind from existing config.yaml: ${k} (pass --channel-kind to change)"
  elif [ -t 0 ] && [ "$DRY_RUN" != 1 ] && { want config || want daemon; }; then
    printf '[install] channel daemon kind — telegram or lark? [telegram]: ' >&2
    read -r k </dev/tty 2>/dev/null || k=""
    [ -z "$k" ] && k="telegram"
  else
    k="telegram"
  fi
  case "$k" in
    telegram|lark) ACTIVE_KIND="$k" ;;
    *) log "✖ channel-kind='$k' is invalid (expected telegram|lark)"; exit 2 ;;
  esac
  log "active channel daemon = ${ACTIVE_KIND} (both daemons deploy; only ${ACTIVE_KIND} is started)"
}
resolve_active_kind

# ── Target runtime/ layout ───────────────────────────────────────────────
#   $RUNTIME/
#     bin/ka            ka CLI (copy, not symlink; D1)
#     ops/              ops scripts (copy)
#     mcp/<name>/       node MCP deploy (dist copy; D2)
#     daemon/           telegram-channel daemon (moved from ~/.telegram-channel; D2/P1.4)
#     core-cli/*-cli.js  core CLI (called by the kb skill; tsup dist self-contained, plain copy)
#     skills/<name>/SKILL.md  skills (design→runtime copy; switch_skills then symlinks)
#   Pointers into runtime/ (cc's turf, but the symlink points at runtime, §1.1):
#     ~/.claude/skills/<name>/SKILL.md  → runtime/skills/<name>/SKILL.md (created by switch_skills)
#     ~/.claude.json           MCP registration (cc's turf; register_mcp points it at runtime/mcp)
#     ~/Library/LaunchAgents/  launchd plist (platform-mandated)
#   Runtime data (already lives in KA_HOME; install leaves it alone):
#     config.yaml / secrets.yaml / cron.yaml / workshop.yaml / state/ / raw/ / *-venv/

# ── Component deploy functions (P1.1 skeleton; TODOs filled in over later steps) ──

deploy_ka() {            # ka CLI + the by-part sh trees copied to runtime (D1, not a symlink)
  want ka || return 0
  log "ka CLI + by-part ops → ${RUNTIME} (copy, not symlink, D1)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] cp repo/shared/bin/ka -> ${RUNTIME}/shared/bin/ka"
    echo "  [dry-run] cp repo/{shared,workshop,channels,cron,kb}/ops -> ${RUNTIME}/<part>/ops; cp config/*.example.* -> ${RUNTIME}/config (templates only; NEVER touch config.yaml/secrets.yaml/state)"
    return 0
  fi
  mkdir -p "$RUNTIME/shared/bin"
  cp "$REPO_ROOT/shared/bin/ka" "$RUNTIME/shared/bin/ka"; chmod +x "$RUNTIME/shared/bin/ka"
  # WHITELIST: install only ever rewrites the code dirs (<part>/ops here; the compiled
  # artifacts go under their part in the other deploy_* fns). It NEVER removes config/
  # or state/ — those are user data. This is the safety guarantee that replaces the
  # old runtime/ wrapper.
  local part
  for part in shared workshop channels cron kb; do
    rm -rf "$RUNTIME/$part/ops"; mkdir -p "$RUNTIME/$part"
    cp -R "$REPO_ROOT/$part/ops" "$RUNTIME/$part/ops"
  done
  # config templates only — copy the *.example.* in, but NEVER wipe config/ (it also
  # holds the live config.yaml / secrets.yaml). state/ is never touched by install.
  mkdir -p "$RUNTIME/config"
  cp "$REPO_ROOT/config/"*.example.* "$RUNTIME/config/" 2>/dev/null || true
  # KA_HOME IS the by-part tree, rooted directly (no wrapper): every script resolves
  # $KA_HOME/<part>/…; data (config/ + state/) lives alongside, untouched by install.
  log "  OK ${RUNTIME}/{shared/bin/ka,shared/ops,workshop/ops,channels/ops,cron/ops,kb/ops; config templates}"
}

deploy_node_mcp() {      # P1.2 — pure-JS node MCPs (no native deps): single self-contained esbuild bundle.
  want node-mcp || return 0
  # NOTE: kb (knowledge-assistant) is NO LONGER bundled here — its LanceDB engine
  # pulls in native modules (onnxruntime via fastembed, lancedb's .node) that can't
  # be esbuild-bundled. It ships via deploy_kb_mcp() (pnpm deploy + node_modules).
  # esbuild binary (repo-root .pnpm, a transitive dependency of tsup). The bundle
  # packs all dependencies (including the workspace package @ka/core) into a single
  # file → self-contained, bypasses the pnpm symlink farm, never points at repo.
  local ESB; ESB="$(find "$REPO_ROOT/node_modules/.pnpm" -path '*esbuild@*/node_modules/esbuild/bin/esbuild' -type f 2>/dev/null | head -1 || true)"
  for spec in "market=kb/tools/market-mcp"; do
    local name="${spec%%=*}" pkg="${spec#*=}" dest="$RUNTIME/kb/mcp/${spec%%=*}"
    log "node MCP [$name]: esbuild bundle -> $dest/index.mjs"
    if [ "$DRY_RUN" = 1 ]; then
      echo "  [dry-run] mkdir -p $dest; esbuild $pkg/src/index.ts --bundle -> $dest/index.mjs"
    else
      [ -n "$ESB" ] || { log "  WARN esbuild not found, skipping"; return 0; }
      mkdir -p "$dest"
      # --banner injects createRequire: when the bundle contains CJS dependencies (e.g.
      # yaml), the ESM output's dynamic require needs a real require, otherwise it fails
      # at runtime with "Dynamic require of X not supported".
      if "$ESB" "$REPO_ROOT/$pkg/src/index.ts" --bundle --platform=node --format=esm --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" --outfile="$dest/index.mjs" >/dev/null 2>&1; then
        log "  OK $dest/index.mjs ($(wc -c < "$dest/index.mjs" | tr -d ' ')B, self-contained)"
      else
        log "  FAIL bundle"
      fi
    fi
  done
}

deploy_kb_mcp() {        # kb (knowledge-assistant) MCP + kb-retrieval daemon — native deps
  want node-mcp || return 0
  # The kb MCP's single backend is the LanceDB hybrid engine, which pulls in NATIVE
  # modules (fastembed→onnxruntime, @lancedb/lancedb's .node) that esbuild can't
  # bundle. Strategy (hybrid of the channel-daemon bundle + the opennutrition copy):
  #   1. esbuild BOTH entries to self-contained .mjs — @ka/core + every pure-JS dep
  #      inlined; ONLY the 3 native packages left external.
  #   2. `npm install` just those 3 natives into $dest/node_modules so the platform's
  #      .node files resolve next to the bundle (no pnpm symlink farm, no repo pointer).
  # Entries: dist/index.mjs (stdio MCP) + dist/daemon.mjs (the kb-retrieval HTTP daemon).
  # 🔴 Non-disruptive: only lays down the artifact. Does NOT register the MCP
  #    (register_mcp, --switch) and does NOT start the daemon (ka kb start /
  #    阶段B). A plain install never changes a running CC.
  local src="$REPO_ROOT/kb/mcp-server" dest="$RUNTIME/kb/mcp/kb"
  log "kb MCP + kb-retrieval daemon → ${dest} (esbuild self-contained + npm install natives)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] pnpm --filter @ka/core build  (esbuild resolves @ka/core from its dist)"
    echo "  [dry-run] esbuild src/{index,daemon}.ts --bundle --external:onnxruntime-node,@lancedb/lancedb,fastembed -> ${dest}/dist/{index,daemon}.mjs"
    echo "  [dry-run] write ${dest}/package.json (natives) + npm install --omit=dev (materialize @lancedb/fastembed/onnxruntime for this platform)"
    echo "  [dry-run] cp kb/ops/kb-retrieval/*.sh -> ${dest}; model cache: keep ${dest}/local_cache if present, else copy repo local_cache (one-time multi-GB) else warn"
    return 0
  fi
  local ESB; ESB="$(find "$REPO_ROOT/node_modules/.pnpm" -path '*esbuild@*/node_modules/esbuild/bin/esbuild' -type f 2>/dev/null | head -1 || true)"
  [ -n "$ESB" ] || { log "  WARN esbuild not found (need pnpm install), skipping"; return 0; }
  command -v npm >/dev/null 2>&1 || { log "  WARN npm not found, skipping"; return 0; }
  # 1) Build @ka/core so esbuild resolves it from dist (its lazy-loaded lance-engine
  #    chunk keeps the bundle's native refs behind the dynamic import).
  ( cd "$REPO_ROOT" && pnpm --filter @ka/core build >/dev/null 2>&1 ) \
    || { log "  FAIL build @ka/core"; return 0; }
  # 2) 🔒 Back up current dist+scripts (rollback net) — only if previously deployed.
  if [ -d "$dest" ] && [ -e "$dest/daemon.sh" ]; then
    local bak="${dest}.bak.$(date +%Y%m%d-%H%M%S)"
    rm -rf "$bak"; mkdir -p "$bak"
    cp -a "$dest/dist" "$bak/dist" 2>/dev/null || true
    cp -a "$dest"/*.sh "$bak/" 2>/dev/null || true
    log "  🔒 backed up current dist+scripts → ${bak}  (rollback: ka kb stop; restore dist/*.sh; ka kb start)"
  fi
  # 3) esbuild both entries → self-contained .mjs (natives external).
  mkdir -p "$dest/dist"
  local e ok=1
  for e in index daemon; do
    if ! "$ESB" "$src/src/$e.ts" --bundle --platform=node --format=esm \
        --external:onnxruntime-node --external:@lancedb/lancedb --external:fastembed \
        --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" \
        --outfile="$dest/dist/$e.mjs" >/dev/null 2>&1; then
      log "  FAIL esbuild $e.ts"; ok=0
    fi
  done
  [ "$ok" = 1 ] || return 0
  # 4) Materialize the native deps next to the bundle (npm resolves the platform
  #    closure: @lancedb/lancedb + its platform .node, fastembed + onnxruntime-node).
  cat > "$dest/package.json" <<'EOF'
{
  "name": "ka-kb-mcp-deploy",
  "private": true,
  "type": "module",
  "description": "Deployed kb MCP + kb-retrieval daemon. dist/*.mjs are self-contained esbuild bundles; node_modules holds ONLY the native deps that can't be bundled.",
  "dependencies": {
    "@lancedb/lancedb": "^0.30.0",
    "fastembed": "^2.1.0"
  }
}
EOF
  if ! ( cd "$dest" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ); then
    log "  FAIL npm install natives (need network on first deploy)"; return 0
  fi
  [ -d "$dest/node_modules/@lancedb" ] && [ -d "$dest/node_modules/fastembed" ] \
    || { log "  FAIL native deps missing after npm install"; return 0; }
  # 5) Launch scripts for the kb-retrieval daemon.
  local f
  for f in daemon.sh start.sh stop.sh status.sh; do
    cp "$REPO_ROOT/kb/ops/kb-retrieval/$f" "$dest/$f"
  done
  chmod +x "$dest"/*.sh
  # 6) Embedding model cache (fastembed ONNX, multi-GB). Persist across installs:
  #    keep an existing one; else copy from the single shared dev cache (the embedder's
  #    DEFAULT_EMBED_CACHE_DIR = ~/.cache/ka-toolkit/fastembed); else download on first
  #    run. daemon.sh exports KA_EMBED_CACHE_DIR=$dest/local_cache so the daemon uses
  #    this shipped copy (offline), not the dev default.
  if [ -e "$dest/local_cache" ]; then
    log "  model cache present at ${dest}/local_cache (kept)"
  else
    local cache_src=""
    [ -d "$HOME/.cache/ka-toolkit/fastembed" ] && cache_src="$HOME/.cache/ka-toolkit/fastembed"
    if [ -n "$cache_src" ]; then
      log "  copying model cache ${cache_src} → ${dest}/local_cache (one-time, multi-GB)…"
      cp -R "$cache_src" "$dest/local_cache"
    else
      log "  ⚠️ no shared model cache (~/.cache/ka-toolkit/fastembed) — the daemon will download multilingual-e5-large to ${dest}/local_cache on first run (needs network)"
    fi
  fi
  local nmsz; nmsz="$(du -sh "$dest/node_modules" 2>/dev/null | cut -f1)"
  log "  OK ${dest} (dist[index.mjs+daemon.mjs] + node_modules[${nmsz}, natives only] + scripts; deployed, NOT registered/started)"
  # Autostart / keepalive is NOT a custom plist here — it is a `ka cron` job
  # (kb-retrieval-keepalive: `ka kb start` on a short interval, a no-op when the daemon
  # is already up via the port singleton). That reuses the cron launchd plumbing
  # (cron-run.sh sets PATH so node resolves — a bare LaunchAgent's minimal PATH does
  # NOT) and self-heals a mid-session death, not just reboot. See cron.yaml.
}

deploy_opennutrition() { # P1.4: node MCP special case (native better-sqlite3 + compressed dataset)
  want node-mcp || return 0
  # Cannot esbuild-bundle: better-sqlite3 is native (.node), and at runtime it reads the
  # sqlite db generated by convert-data (build/../data_local/opennutrition_foods.db).
  # Single-machine copy model (D4): build once in the repo to produce build/ +
  # data_local/db + compiled node_modules, then copy the whole thing to runtime —
  # same machine, same platform, zero recompile, zero network.
  local src="$REPO_ROOT/kb/tools/mcp-opennutrition" dest="$RUNTIME/kb/mcp/opennutrition"
  log "node MCP [opennutrition]: special case (native sqlite + dataset) -> $dest"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] ensure $src is built (build/index.js + data_local/*.db)"
    echo "  [dry-run] cp -R build/ data_local/ node_modules/ package.json -> $dest"
    return 0
  fi
  command -v npm >/dev/null 2>&1 || { log "  WARN npm not found, skipping"; return 0; }
  # 1. Ensure the repo is built (only rebuild if artifacts are missing, to avoid a 62MB
  #    unpack on every install)
  if [ ! -f "$src/build/index.js" ] || ! ls "$src"/data_local/*.db >/dev/null 2>&1; then
    log "  build artifacts missing, running npm ci && npm run build (unpack dataset + build sqlite, slow)"
    # npm ci: install exactly per lock, don't rewrite package-lock (avoids polluting
    # reproducibility with this machine's mirror URLs)
    ( cd "$src" && npm ci >/dev/null 2>&1 && npm run build >/dev/null 2>&1 ) \
      || { log "  FAIL build"; return 0; }
  fi
  [ -f "$src/build/index.js" ] && ls "$src"/data_local/*.db >/dev/null 2>&1 \
    || { log "  FAIL build artifacts still missing"; return 0; }
  # 2. Copy the whole deploy artifact (build/ + generated db + compiled native node_modules)
  rm -rf "$dest"; mkdir -p "$dest"
  cp -R "$src/build" "$dest/build"
  cp -R "$src/data_local" "$dest/data_local"
  cp -R "$src/node_modules" "$dest/node_modules"
  cp "$src/package.json" "$dest/package.json"
  # node_modules/.bin holds build-tool wrappers generated at npm install time
  # (esbuild/semver/tsc…) whose contents hardcode the repo's NODE_PATH. The run entry
  # is node build/index.js, which never invokes .bin, so deleting them →
  # runtime/mcp/opennutrition is truly self-contained with no repo paths inside.
  rm -rf "$dest/node_modules/.bin"
  local dbsz; dbsz="$(du -sh "$dest/data_local" 2>/dev/null | cut -f1)"
  log "  OK ${dest} (build + data_local[${dbsz}] + node_modules sans .bin; self-contained, runnable via node build/index.js)"
}

deploy_python_mcp() {    # P1.3
  want python-mcp || return 0
  # uv build wheel (setuptools backend) + uv pip install into a venv (--force-reinstall).
  # What's installed is a real copy of the code from the wheel (not an editable .pth),
  # so the venv no longer points at the repo.
  local UV; UV="$(command -v uv 2>/dev/null || echo "$HOME/.local/bin/uv")"
  for spec in "ibkr=kb/tools/ibkr-mcp" "hkprop=kb/tools/hkprop-mcp"; do
    local name="${spec%%=*}" pkg="${spec#*=}"
    local venv="$KA_HOME/kb/venvs/${name}"
    log "python MCP [$name]: uv build wheel + install into ${venv} (non-editable)"
    if [ "$DRY_RUN" = 1 ]; then
      echo "  [dry-run] uv build --wheel $pkg; uv venv $venv; uv pip install --force-reinstall <wheel>"
    else
      [ -x "$UV" ] || { log "  WARN uv not found, skipping"; return 0; }
      local wd; wd="$(mktemp -d)"
      if "$UV" build --wheel --out-dir "$wd" "$REPO_ROOT/$pkg" >/dev/null 2>&1; then
        local whl; whl="$(ls "$wd"/*.whl 2>/dev/null | head -1)"
        [ -d "$venv" ] || "$UV" venv "$venv" >/dev/null 2>&1
        if "$UV" pip install --python "$venv/bin/python" --force-reinstall "$whl" >/dev/null 2>&1; then
          log "  OK $name → $(basename "$whl") installed into venv (copy, non-editable)"
        else
          log "  FAIL pip install"
        fi
      else
        log "  FAIL uv build wheel"
      fi
      rm -rf "$wd"
    fi
  done
}

deploy_daemon() {        # telegram channel daemon → runtime/telegram-daemon (esbuild single-file bundle)
  want daemon || return 0
  # Always deployed (both daemons ship); only the ACTIVE kind is started at switch.
  # channel-core kernel + telegram-platform plugin + deps (grammy/express/sdk) esbuild'd
  # into a single self-contained daemon.mjs → runtime holds no .ts source and no node_modules.
  # 🔴 Bundle via a "generated temp static entry" (import platform/init + runChannelDaemon) —
  #    a single module graph guarantees a single channel-core instance (shared
  #    byName/sessionsById/counters); bundling core and platform separately would
  #    duplicate the kernel → session state not shared → broken.
  # 🔴 Do NOT touch secrets/state (config/secrets.yaml live in $KA_HOME/config; the
  #    daemon reads them at runtime), do not restart, do not change registration;
  #    the actual switch is --switch.
  local src="$REPO_ROOT/channels/telegram" dest="$RUNTIME/channels/telegram-daemon"
  log "channel daemon → ${dest} (esbuild single-file bundle: core+telegram-platform+deps self-contained, runtime has no source)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] generate temp static entry → esbuild --bundle → ${dest}/daemon.mjs (single core instance, self-contained)"
    echo "  [dry-run] cp daemon.sh start.sh stop.sh status.sh -> ${dest} (no .ts / no node_modules; config from \$KA_HOME/config)"
    return 0
  fi
  local ESB; ESB="$(find "$REPO_ROOT/node_modules/.pnpm" -path '*esbuild@*/node_modules/esbuild/bin/esbuild' -type f 2>/dev/null | head -1 || true)"
  [ -n "$ESB" ] || { log "  WARN esbuild not found (need pnpm install), skipping"; return 0; }
  # 🔒 Auto-backup: before overwriting, back up the whole currently-working deploy dir
  # (rollback safety net). Only back up when dest already has a daemon.sh (i.e. it was
  # deployed before). Rollback: stop → rm -rf <dest> && mv <bak> <dest> → start.
  if [ -d "$dest" ] && [ -e "$dest/daemon.sh" ]; then
    local bak="${dest}.bak.$(date +%Y%m%d-%H%M%S)"
    cp -a "$dest" "$bak"
    log "  🔒 backed up current daemon → ${bak}"
    log "     rollback: ${dest}/stop.sh; rm -rf ${dest}; mv ${bak} ${dest}; ${dest}/start.sh"
  fi
  mkdir -p "$dest"
  # Temp static entry (placed inside the platform package so relative + node_modules resolution is natural).
  local entry="$src/.bundle-entry.tmp.ts"
  cat > "$entry" <<'EOF'
// Generated by install.sh deploy_daemon — esbuild entry. A single static graph so
// channel-core is instantiated ONCE (shared byName/sessionsById/counters).
import { platform, init } from './telegram-platform.ts'
import { runChannelDaemon } from '../core/src/daemon.ts'
runChannelDaemon({ platform, ...init() })
EOF
  # --format=esm + .mjs: node runs it explicitly as ESM (no package.json type needed). The
  # banner injects createRequire to back any bare require inside the bundle (used indirectly
  # by CJS deps, same as deploy_hooks).
  if "$ESB" "$entry" --bundle --platform=node --format=esm \
      --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" \
      --outfile="$dest/daemon.mjs" >/dev/null 2>&1; then
    rm -f "$entry"
    log "  OK bundle → ${dest}/daemon.mjs (self-contained, single core instance)"
  else
    rm -f "$entry"
    log "  FAIL esbuild daemon bundle (see above)"; return 0
  fi
  local f
  for f in daemon.sh start.sh stop.sh status.sh; do
    [ -f "$src/$f" ] && cp "$src/$f" "$dest/$f"
  done
  chmod +x "$dest"/*.sh 2>/dev/null || true
  # No per-daemon config to seed: the daemon reads config.yaml/secrets.yaml from
  # $KA_HOME/config (seeded by deploy_config). config.example.json is dead in the
  # new layout — prune it (a template, no secrets), but NEVER the old config.json/
  # .env (they may still hold the running daemon's token until the owner migrates
  # those secrets into secrets.yaml at --switch time).
  # Prune previous-generation (pre-bundle) artifacts: raw server.ts + node_modules +
  # package*.json + tg-ch are superseded by the self-contained bundle and are dead code if
  # left behind. Keep secrets/state/logs/attachments.
  local stale
  for stale in server.ts node_modules package.json package-lock.json tg-ch config.example.json; do
    [ -e "$dest/$stale" ] && { rm -rf "$dest/$stale"; log "  pruned previous-gen: $stale"; }
  done
  log "  OK ${dest} (bundle + scripts in place; config from \$KA_HOME/config, owner migrates legacy secrets at --switch)"
}

deploy_lark_daemon() {   # lark channel daemon → runtime/lark-daemon (esbuild single-file bundle)
  want daemon || return 0
  # Always deployed (both daemons ship); only the ACTIVE kind is started at switch.
  # Same as deploy_daemon: channel-core kernel + lark-platform plugin + deps esbuild'd into a
  # single self-contained daemon.mjs (generated temp static entry guarantees a single core
  # instance). runtime/lark-daemon has no .ts/node_modules.
  # 🔴 Do NOT touch secrets/state (config/secrets.yaml live in $KA_HOME/config —
  #    the webhook tokens are in secrets.yaml channels.lark), do not restart, do
  #    not change registration; the actual switch is --switch.
  local src="$REPO_ROOT/channels/lark" dest="$RUNTIME/channels/lark-daemon"
  log "lark daemon → ${dest} (esbuild: core+lark-platform+deps self-contained, runtime has no source)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] generate temp static entry → esbuild --bundle → ${dest}/daemon.mjs (single core instance)"
    echo "  [dry-run] cp daemon.sh start.sh stop.sh status.sh -> ${dest} (config from \$KA_HOME/config)"
    return 0
  fi
  local ESB; ESB="$(find "$REPO_ROOT/node_modules/.pnpm" -path '*esbuild@*/node_modules/esbuild/bin/esbuild' -type f 2>/dev/null | head -1 || true)"
  [ -n "$ESB" ] || { log "  WARN esbuild not found (need pnpm install), skipping"; return 0; }
  if [ -d "$dest" ] && [ -e "$dest/daemon.sh" ]; then
    local bak="${dest}.bak.$(date +%Y%m%d-%H%M%S)"
    cp -a "$dest" "$bak"
    log "  🔒 backed up current lark daemon → ${bak}"
    log "     rollback: ${dest}/stop.sh; rm -rf ${dest}; mv ${bak} ${dest}; ${dest}/start.sh"
  fi
  mkdir -p "$dest"
  local entry="$src/.bundle-entry.tmp.ts"
  cat > "$entry" <<'EOF'
// Generated by install.sh deploy_lark_daemon — esbuild entry. Single static graph
// so channel-core is instantiated ONCE (shared byName/sessionsById/counters).
import { platform, init } from './lark-platform.ts'
import { runChannelDaemon } from '../core/src/daemon.ts'
runChannelDaemon({ platform, ...init() })
EOF
  if "$ESB" "$entry" --bundle --platform=node --format=esm \
      --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" \
      --outfile="$dest/daemon.mjs" >/dev/null 2>&1; then
    rm -f "$entry"
    log "  OK bundle → ${dest}/daemon.mjs (self-contained, single core instance)"
  else
    rm -f "$entry"
    log "  FAIL esbuild lark daemon bundle"; return 0
  fi
  local f
  for f in daemon.sh start.sh stop.sh status.sh; do
    [ -f "$src/$f" ] && cp "$src/$f" "$dest/$f"
  done
  chmod +x "$dest"/*.sh 2>/dev/null || true
  # No per-daemon config to seed: the daemon reads config.yaml/secrets.yaml from
  # $KA_HOME/config. Prune the dead config.example.json template (never the old
  # config.json/.env — they may hold the running daemon's creds until migration).
  local stale
  for stale in server.ts node_modules package.json package-lock.json config.example.json; do
    [ -e "$dest/$stale" ] && { rm -rf "$dest/$stale"; log "  pruned previous-gen: $stale"; }
  done
  log "  OK ${dest} (bundle + scripts in place; fill channels.lark in config.yaml/secrets.yaml)"
}

deploy_hooks() {         # CC hooks (capture-hook) → runtime (esbuild bundle + prune stale; @ka/core bundled in, self-contained)
  want hooks || return 0
  local src="$REPO_ROOT/kb/adapter-cc/dist/hooks" dest="$RUNTIME/kb/hooks"
  log "CC hooks → ${dest} (esbuild bundle; workspace deps like @ka/core bundled in, self-contained)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] esbuild --bundle ${src}/*.js -> ${dest} (self-contained, no dependence on @ka/core in repo node_modules)"
    return 0
  fi
  if [ ! -d "$src" ]; then
    log "  WARN hooks dist missing (build adapters in the repo first): ${src} — skipping"
    return 0
  fi
  # dist/hooks/*.js import @ka/core (a workspace package). A plain copy to runtime leaves node
  # unable to find @ka/core (runtime/hooks has no node_modules) → ERR_MODULE_NOT_FOUND. Like
  # node MCP, esbuild --bundle packs @ka/core into the single file → self-contained, no repo dependence.
  local ESB; ESB="$(find "$REPO_ROOT/node_modules/.pnpm" -path '*esbuild@*/node_modules/esbuild/bin/esbuild' -type f 2>/dev/null | head -1 || true)"
  [ -n "$ESB" ] || { log "  WARN esbuild not found (need pnpm install), skipping"; return 0; }
  mkdir -p "$dest"
  local h name cnt=0
  for h in "$src"/*.js; do
    [ -f "$h" ] || continue
    name="$(basename "$h")"
    # --banner same as deploy_node_mcp: when the bundle contains CJS deps (@ka/core uses yaml
    # indirectly), a bare require in the ESM output hits esbuild's "Dynamic require not
    # supported" stub (observed with compact-hook). Inject createRequire as a fallback.
    if "$ESB" "$h" --bundle --platform=node --format=esm --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" --outfile="$dest/$name" >/dev/null 2>&1; then
      cnt=$((cnt + 1))
    else
      log "  FAIL bundle $name"
    fi
  done
  # Prune stale hooks: drop any runtime hook whose source was removed (e.g.
  # compact-hook). Done AFTER bundling so a bundle failure never empties dest.
  local d bn
  for d in "$dest"/*.js; do
    [ -f "$d" ] || continue
    bn="$(basename "$d")"
    if [ ! -f "$src/$bn" ]; then
      rm -f "$d" "${d}.map"
      log "  pruned stale hook: $bn (source removed)"
    fi
  done
  # Codex uses the same runtime destination but a distinct filename so its Stop
  # hook can coexist with the Claude Code capture hook.
  local codex_hook="$REPO_ROOT/kb/adapter-codex/dist/hooks/capture-hook.js"
  if [ -f "$codex_hook" ]; then
    if "$ESB" "$codex_hook" --bundle --platform=node --format=esm --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" --outfile="$dest/codex-capture-hook.js" >/dev/null 2>&1; then
      cnt=$((cnt + 1))
    else
      log "  FAIL bundle codex-capture-hook.js"
    fi
  else
    log "  WARN Codex hook dist missing (build @ka/adapter-codex first): ${codex_hook}"
  fi
  log "  OK ${dest} (${cnt} hook(s), esbuild bundle self-contained, no external @ka/core resolution needed)"
}

deploy_core_cli() {      # core CLI (called by kb skill) → runtime/core-cli (tsup dist already self-contained, plain copy)
  want core-cli || return 0
  local src="$REPO_ROOT/kb/core/dist" dest="$RUNTIME/kb/core/dist"
  log "core CLI → ${dest} (kb/core/dist/*-cli.js, already tsup-bundled self-contained, plain copy)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] cp ${src}/*-cli.js -> ${dest}/"
    return 0
  fi
  if [ ! -d "$src" ]; then
    log "  WARN core dist missing (run pnpm build core in the repo first): ${src} — skipping"
    return 0
  fi
  mkdir -p "$dest"
  local f cnt=0
  for f in "$src"/*-cli.js; do
    [ -f "$f" ] || continue
    cp "$f" "$dest/"; cnt=$((cnt + 1))
  done
  # Runtime-specific transcript readers keep their format knowledge in the
  # adapter while sharing the same deployed CLI directory with the worker.
  local codex_reader="$REPO_ROOT/kb/adapter-codex/dist/rollout-reader-cli.js"
  if [ -f "$codex_reader" ]; then
    cp "$codex_reader" "$dest/codex-rollout-reader-cli.js"; cnt=$((cnt + 1))
  else
    log "  WARN Codex rollout reader missing (run pnpm build first): ${codex_reader}"
  fi
  log "  OK ${dest} (${cnt} core CLI(s) copied into runtime; kb skill no longer points at repo)"
}

deploy_skills() {        # skills → runtime/skills/<name>/SKILL.md (design→runtime copy; symlink created by switch_skills)
  want skills || return 0
  local dest="$RUNTIME/kb/skills"
  log "skills → ${dest} (copy kb/skills/*.md; symlink pointed at runtime by switch_skills)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] cp kb/skills/*.md -> ${dest}/<name>/SKILL.md (incl the kb entry kb/skills/kb.md)"
    return 0
  fi
  mkdir -p "$dest"
  # All skill sources live flat under kb/skills/*.md (the /kb entry kb.md included —
  # the old kb/skill package shell was merged in). Each → runtime/kb/skills/<name>/SKILL.md.
  local f name cnt=0
  for f in "$REPO_ROOT"/kb/skills/*.md; do
    [ -f "$f" ] || continue
    name="$(basename "$f" .md)"
    mkdir -p "$dest/$name"; cp "$f" "$dest/$name/SKILL.md"; cnt=$((cnt + 1))
  done
  log "  OK ${dest} (${cnt} skill(s) copied into runtime; pure docs, self-contained)"
}

seed_config() {          # seed config/data directories (never overwrites existing user data)
  want config || return 0
  log "seed config/data directories → ${KA_HOME} (does not overwrite existing)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] mkdir -p ${KA_HOME}/{config,state} (the two data buckets); seed config/workshop.yaml + config/config.yaml from examples (if missing); upsert config.yaml channel_kind=${ACTIVE_KIND}"
    return 0
  fi
  # Data lives in exactly two buckets: config/ (declarative) + state/ (mutable).
  # (The KB store creates its own raw/ + pending-topics under the configured
  # knowledge_base_path, not here.)
  mkdir -p "$KA_HOME"/config "$KA_HOME"/state
  local seeded=0
  if [ -f "$REPO_ROOT/config/workshop.example.yaml" ] && [ ! -f "$KA_HOME/config/workshop.yaml" ]; then
    cp "$REPO_ROOT/config/workshop.example.yaml" "$KA_HOME/config/workshop.yaml"; seeded=$((seeded + 1))
  fi
  if [ -f "$REPO_ROOT/config/config.example.yaml" ] && [ ! -f "$CONFIG_YAML" ]; then
    cp "$REPO_ROOT/config/config.example.yaml" "$CONFIG_YAML"; seeded=$((seeded + 1))
  fi
  # Persist the active channel daemon kind (single source of truth). Upsert the
  # top-level `channel_kind:` line in config.yaml, touching nothing else.
  if [ -n "$ACTIVE_KIND" ] && [ -f "$CONFIG_YAML" ]; then
    CONFIG_YAML="$CONFIG_YAML" ACTIVE_KIND="$ACTIVE_KIND" python3 - <<'PY'
import os, re
p = os.environ["CONFIG_YAML"]; kind = os.environ["ACTIVE_KIND"]
with open(p) as f: lines = f.read().splitlines()
out=[]; done=False
for ln in lines:
    if re.match(r'^[ \t]*channel_kind[ \t]*:', ln):
        out.append(f"channel_kind: {kind}"); done=True
    else:
        out.append(ln)
if not done: out.insert(0, f"channel_kind: {kind}")
with open(p, "w") as f: f.write("\n".join(out) + "\n")
PY
    log "  OK config.yaml channel_kind = ${ACTIVE_KIND}"
  fi
  log "  OK data directories ready; seeded ${seeded} new config(s) (all existing files kept, never overwritten)"
}

# ── Switch steps (--switch; each step backs up to .pre-switch first) ──────────
register_mcp() {         # switch ①: point CLAUDE_JSON's node MCP at runtime/mcp
  want node-mcp || return 0
  [ "$DO_SWITCH" = 1 ] || { log "register MCP → SKIPPED (needs --switch; won't change a running registration on its own)"; return 0; }
  log "switch ① node MCP registration → ${CLAUDE_JSON} pointed at ${RUNTIME}/mcp (backed up)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] cp ${CLAUDE_JSON} ${CLAUDE_JSON}.pre-switch; point kb/market-data/opennutrition at runtime/mcp"
    return 0
  fi
  [ -f "$CLAUDE_JSON" ] || { log "  WARN ${CLAUDE_JSON} does not exist, skipping"; return 0; }
  cp "$CLAUDE_JSON" "${CLAUDE_JSON}.pre-switch-$(date +%Y%m%d%H%M%S)"
  RT="$RUNTIME" python3 - "$CLAUDE_JSON" <<'PY'
import json, os, shlex, sys
rt = os.environ["RT"]; p = sys.argv[1]
d = json.load(open(p))
ms = d.get("mcpServers", {})
mapping = {
    # kb ships as a self-contained esbuild bundle (dist/index.mjs) with an adjacent
    # node_modules holding only the native LanceDB deps. (阶段B may instead register
    # kb as type:http pointing at the kb-retrieval daemon on the configured port.)
    "knowledge-assistant": f"{rt}/kb/mcp/kb/dist/index.mjs",
    "market-data":         f"{rt}/kb/mcp/market/index.mjs",
    "opennutrition":       f"{rt}/kb/mcp/opennutrition/build/index.js",
}
changed = []
for name, entry in mapping.items():
    if name in ms:
        ms[name]["command"] = "node"; ms[name]["args"] = [entry]; changed.append(name)
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
print("  rewired:", ",".join(changed) if changed else "(none matched)")
PY
  log "  OK node MCP pointed at runtime/mcp (the python MCP venv already lives runtime-side, left alone)"
}

switch_ka_link() {       # switch ②: ka command symlink → runtime/bin/ka
  want ka || return 0
  [ "$DO_SWITCH" = 1 ] || return 0
  log "switch ② ka symlink → ${KA_BIN_LINK} pointed at ${RUNTIME}/shared/bin/ka (back up old target)"
  if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] readlink backup; ln -sf ${RUNTIME}/shared/bin/ka ${KA_BIN_LINK}"; return 0; fi
  [ -L "$KA_BIN_LINK" ] && { readlink "$KA_BIN_LINK" > "${KA_BIN_LINK}.pre-switch-target" 2>/dev/null || true; }
  mkdir -p "$(dirname "$KA_BIN_LINK")"
  ln -sf "$RUNTIME/shared/bin/ka" "$KA_BIN_LINK"
  log "  OK ${KA_BIN_LINK} -> ${RUNTIME}/shared/bin/ka"
}

switch_cron() {          # switch ③: re-point cron plist at runtime/cron/ops/cron-run.sh
  want cron || return 0
  [ "$DO_SWITCH" = 1 ] || return 0
  # macOS/launchd only: rewrite the legacy launchd plist's cron-run.sh path to runtime.
  # Linux has no launchd plist — cron uses the crontab backend: after setting up cron.yaml,
  # run `ka cron install` (detect_backend Linux→crontab). Skip here.
  if [ "$(uname -s)" != "Darwin" ]; then
    log "switch ③ cron → Linux: skip launchd plist rewrite; use \`ka cron install\` (crontab backend) to install scheduled jobs"
    return 0
  fi
  log "switch ③ cron plist → re-point at ${RUNTIME}/cron/ops/cron-run.sh (backup + sed)"
  if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] backup *.plist; rewrite cron-run.sh path -> runtime; launchctl bootout/bootstrap reload"; return 0; fi
  local changed=0 p
  for p in "$LAUNCHAGENTS_DIR"/com.knowledge-assistant.ka.cron.*.plist; do
    [ -f "$p" ] || continue
    cp "$p" "${p}.pre-switch"
    # Match any prefix of .../ops/scripts/cron-run.sh (a switch may run from a worktree or the
    # main workspace, so the plist's old path prefix is unpredictable) → uniformly re-point at runtime.
    RT="$RUNTIME" python3 - "$p" <<'PY'
import os, re, sys
rt = os.environ["RT"]; p = sys.argv[1]
raw = open(p).read()
# Use /[^<>\s]* for the path prefix, not \S*: in the plist, the <string>/Users/... tag abuts
# the path with no space, so \S* would greedily swallow the whole "<string>/Users/.../runtime"
# segment → after substitution the leading <string> is lost and the plist XML is corrupted.
# Excluding < > makes the match start at the first / after the tag, keeping the tag intact.
open(p, "w").write(re.sub(r'/[^<>\s]*cron-run\.sh', rt + '/cron/ops/cron-run.sh', raw))
PY
    changed=$((changed + 1))
  done
  # Auto-reload (only the real ~/Library/LaunchAgents; skip under an isolated override, don't touch real launchctl)
  if [ "$LAUNCHAGENTS_DIR" = "$HOME/Library/LaunchAgents" ]; then
    local q
    for q in "$LAUNCHAGENTS_DIR"/com.knowledge-assistant.ka.cron.*.plist; do
      [ -f "$q" ] || continue
      launchctl bootout "gui/$(id -u)" "$q" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$(id -u)" "$q" >/dev/null 2>&1 || true
    done
    log "  OK ${changed} cron plist(s) re-pointed at runtime + launchctl reloaded"
  else
    log "  OK ${changed} cron plist(s) re-pointed at runtime (override mode, skipped launchctl reload)"
  fi
}

switch_hooks() {         # switch ④: CLAUDE_SETTINGS hook paths → runtime/hooks
  want hooks || return 0
  [ "$DO_SWITCH" = 1 ] || return 0
  log "switch ④ hooks → ${CLAUDE_SETTINGS} re-pointed at ${RUNTIME}/hooks (backed up)"
  if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] back up + re-point Claude hooks; merge Codex Stop capture into ${CODEX_HOOKS} (preserve existing hooks)"; return 0; fi
  if [ -f "$CLAUDE_SETTINGS" ]; then
    cp "$CLAUDE_SETTINGS" "${CLAUDE_SETTINGS}.pre-switch-$(date +%Y%m%d%H%M%S)"
  # Re-point the hooks dir to the new $KA_HOME/kb/hooks, whatever the settings.json
  # currently points at. Match ALL three known prior locations, not just the gen3
  # repo path — otherwise a machine migrating from an OLD DEPLOYED runtime (hooks at
  # `runtime/hooks`) or an OLD repo layout (`packages/adapters/claude-code/dist/hooks`)
  # is left with stale hook paths that break once the old runtime/ is removed.
    RT="$RUNTIME" python3 - "$CLAUDE_SETTINGS" <<'PY'
import os, re, sys
rt = os.environ["RT"]; p = sys.argv[1]
raw = open(p).read()
# Use /[^<>"\s]* (not \S*) for the prefix to avoid greedily swallowing the leading
# quote/tag. Alternation covers: gen3 repo path, pre-gen3 repo path, and the old
# DEPLOYED runtime/hooks location — all collapse to the new runtime kb/hooks.
raw2 = re.sub(
    r'/[^<>"\s]*/(?:kb/adapter-cc/dist/hooks|packages/adapters/claude-code/dist/hooks|runtime/hooks)',
    rt + "/kb/hooks", raw)
open(p, "w").write(raw2)
print("  hook paths rewired" if raw2 != raw else "  no hook path matched")
PY
    log "  OK Claude hooks re-pointed at runtime/hooks"
  else
    log "  WARN ${CLAUDE_SETTINGS} does not exist; skipping Claude hook switch"
  fi

  local codex_hook="$RUNTIME/kb/hooks/codex-capture-hook.js"
  if [ ! -f "$codex_hook" ]; then
    log "  WARN ${codex_hook} is not deployed; skipping Codex hook switch"
    return 0
  fi
  mkdir -p "$(dirname "$CODEX_HOOKS")"
  [ -f "$CODEX_HOOKS" ] && cp "$CODEX_HOOKS" "${CODEX_HOOKS}.pre-switch-$(date +%Y%m%d%H%M%S)"
  CODEX_HOOK_PATH="$codex_hook" python3 - "$CODEX_HOOKS" <<'PY'
import json, os, shlex, sys
p = sys.argv[1]
try:
    with open(p) as f: data = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    data = {}
hooks = data.setdefault("hooks", {})
groups = hooks.setdefault("Stop", [])
command = "node " + shlex.quote(os.environ["CODEX_HOOK_PATH"])
replacement = {"hooks": [{"type": "command", "command": command, "timeout": 30}]}
for i, group in enumerate(groups):
    handlers = group.get("hooks", []) if isinstance(group, dict) else []
    if any(isinstance(h, dict) and "codex-capture-hook.js" in h.get("command", "") for h in handlers):
        groups[i] = replacement
        break
else:
    groups.append(replacement)
with open(p, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
  log "  OK Codex Stop capture hook registered in ${CODEX_HOOKS} (review trust with /hooks)"
}

switch_daemon() {        # switch ⑤: migrate secrets + (re)start the telegram daemon IFF it is the active kind
  want daemon || return 0
  [ "$ACTIVE_KIND" = "telegram" ] || { log "switch ⑤ telegram daemon → not the active kind (channel_kind=${ACTIVE_KIND}); deployed but NOT started"; return 0; }
  [ "$DO_SWITCH" = 1 ] || return 0
  local dest="$RUNTIME/channels/telegram-daemon"
  local legacy_rt="$RUNTIME/daemon"   # pre-rename runtime location (migrate secrets from, then retire)
  log "switch ⑤ telegram daemon → migrate state + restart ${dest} (active kind)"
  if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] migrate {state.json} from ${legacy_rt} else ${TELEGRAM_DIR} -> ${dest}; stop old (incl ${legacy_rt}) + start ${dest} (telegram drops a few seconds; CCs re-adopt). Secrets now live in \$KA_HOME/config/secrets.yaml — populate channels.telegram there first."; return 0; fi
  [ -d "$dest" ] || { log "  WARN ${dest} not deployed (run deploy_daemon first), skipping"; return 0; }

  # 1) Migrate runtime STATE only (offset/watermark/channel-numbers). Secrets no
  #    longer live in a per-daemon config.json/.env — they're in
  #    $KA_HOME/config/secrets.yaml (channels.telegram), which the owner populates
  #    once (migrating the old config.json token + owner_chat_id). Prefer the
  #    pre-rename runtime dir (runtime/daemon), else the legacy standalone
  #    (~/.telegram-channel). Never overwrite existing.
  local mig_src=""
  if [ -d "$legacy_rt" ]; then mig_src="$legacy_rt"; elif [ -d "$TELEGRAM_DIR" ]; then mig_src="$TELEGRAM_DIR"; fi
  if [ -n "$mig_src" ]; then
    local f migrated=0
    for f in state.json; do
      [ -f "$mig_src/$f" ] && [ ! -f "$dest/$f" ] && { cp "$mig_src/$f" "$dest/$f"; migrated=$((migrated + 1)); }
    done
    log "  OK migrated ${migrated} state file(s) from ${mig_src} (existing not overwritten; secrets → secrets.yaml)"
  else
    log "  no legacy daemon dir to migrate — ${dest} reads config/secrets.yaml from \$KA_HOME/config"
  fi

  # 2) Restart to load the freshly-deployed bundle. Test-safety: only touch the real
  #    daemon when operating on the REAL runtime root — isolated tests override
  #    KA_HOME, so dest != real → skip, never touching the live daemon.
  if [ "$dest" != "$HOME/.knowledge-assistant/channels/telegram-daemon" ]; then
    log "  (override runtime root — skipping daemon restart; not touching the real daemon)"
    return 0
  fi
  log "  restart ${dest} (⚠️ telegram drops for a few seconds; CCs re-adopt)..."
  # Stop whatever is live: legacy standalone, the pre-rename runtime/daemon, AND dest.
  [ -x "$TELEGRAM_DIR/stop.sh" ] && "$TELEGRAM_DIR/stop.sh" >/dev/null 2>&1 || true
  [ -x "$legacy_rt/stop.sh" ] && "$legacy_rt/stop.sh" >/dev/null 2>&1 || true
  [ -x "$dest/stop.sh" ] && "$dest/stop.sh" >/dev/null 2>&1 || true
  sleep 1
  if [ -x "$dest/start.sh" ]; then
    if "$dest/start.sh" >/dev/null 2>&1; then
      log "  OK ${dest} is up (new bundle loaded)"
      [ -d "$legacy_rt" ] && rm -rf "$legacy_rt" && log "  retired pre-rename ${legacy_rt}"
    else
      log "  WARN ${dest} start failed, see ${dest}/daemon.stdout.log"
    fi
  else
    log "  WARN ${dest}/start.sh missing (re-run ./install.sh to update first); not restarted"
  fi
}

switch_lark_daemon() {   # switch ⑤b: start runtime/lark-daemon IFF lark is the active kind
  want daemon || return 0
  [ "$ACTIVE_KIND" = "lark" ] || { log "switch ⑤b lark daemon → not the active kind (channel_kind=${ACTIVE_KIND}); deployed but NOT started"; return 0; }
  [ "$DO_SWITCH" = 1 ] || return 0
  local dest="$RUNTIME/channels/lark-daemon"
  log "switch ⑤b lark daemon → start ${dest} (@9876)"
  if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] migrate state.json from ${LARK_DIR} (no overwrite); stop old + start runtime/lark-daemon. Secrets now live in \$KA_HOME/config/secrets.yaml — populate channels.lark there first."; return 0; fi
  [ -d "$dest" ] || { log "  WARN runtime/lark-daemon not deployed (run deploy_lark_daemon first), skipping"; return 0; }
  # Migrate runtime STATE only from old ~/.lark-channel (if any). Secrets
  # (self_open_id/groups/webhook_url) now live in $KA_HOME/config/secrets.yaml
  # (channels.lark), which the owner populates once.
  if [ -d "$LARK_DIR" ]; then
    local f migrated=0
    for f in state.json; do
      [ -f "$LARK_DIR/$f" ] && [ ! -f "$dest/$f" ] && { cp "$LARK_DIR/$f" "$dest/$f"; migrated=$((migrated + 1)); }
    done
    [ "$migrated" -gt 0 ] && log "  OK migrated ${migrated} state file(s) from ${LARK_DIR} (secrets → secrets.yaml)"
  fi
  log "  stop old + start runtime/lark-daemon..."
  [ -x "$LARK_DIR/stop.sh" ] && "$LARK_DIR/stop.sh" >/dev/null 2>&1 || true
  [ -x "$dest/stop.sh" ] && "$dest/stop.sh" >/dev/null 2>&1 || true
  sleep 1
  if [ -x "$dest/start.sh" ]; then
    if "$dest/start.sh" >/dev/null 2>&1; then log "  OK runtime/lark-daemon is up (on 9876)"; else log "  WARN start failed, see ${dest}/daemon.stdout.log (most likely channels.lark in secrets.yaml isn't filled with real credentials yet)"; fi
  else
    log "  WARN ${dest}/start.sh does not exist"
  fi
}

switch_skills() {        # switch ⑥: ~/.claude/skills/<name>/SKILL.md symlink → runtime/skills (back up old target)
  want skills || return 0
  [ "$DO_SWITCH" = 1 ] || { log "switch skills → SKIPPED (needs --switch; won't change cc's turf symlink on its own)"; return 0; }
  local src="$RUNTIME/kb/skills"
  log "switch ⑥ skills symlink → ${CLAUDE_SKILLS_DIR}/<name>/SKILL.md pointed at ${src} (back up old target)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] for each runtime/skills/<name>: record old symlink target → .pre-switch-target; ln -sf to runtime"
    return 0
  fi
  [ -d "$src" ] || { log "  WARN ${src} does not exist (run deploy_skills first), skipping"; return 0; }
  local d name link tgt cnt=0
  for d in "$src"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    link="$CLAUDE_SKILLS_DIR/$name/SKILL.md"
    mkdir -p "$CLAUDE_SKILLS_DIR/$name"
    # Back up the old symlink target (only when it's currently a symlink and not yet backed up; for the record, cleanup removes it)
    if [ -L "$link" ] && [ ! -f "${link}.pre-switch-target" ]; then
      tgt="$(readlink "$link")"; printf '%s' "$tgt" > "${link}.pre-switch-target"
    fi
    ln -sf "$src/$name/SKILL.md" "$link"; cnt=$((cnt + 1))
  done
  log "  OK ${cnt} skill symlink(s) pointed at runtime/skills (design/runtime separation)"
}

do_cleanup_old() {       # --cleanup-old: after switch is verified OK, remove old standalone deploy + backups (irreversible, use with care)
  log "cleanup-old: remove old daemon + .pre-switch backups (only after switch is verified OK, irreversible)"
  [ -d "$TELEGRAM_DIR" ] && { run "rm -rf '$TELEGRAM_DIR'"; log "  removed old daemon ${TELEGRAM_DIR}"; }
  local b
  for b in "${CLAUDE_JSON}".pre-switch-* "${KA_BIN_LINK}.pre-switch-target" "${CLAUDE_SETTINGS}".pre-switch-* "$LAUNCHAGENTS_DIR"/com.knowledge-assistant.ka.cron.*.plist.pre-switch "$CLAUDE_SKILLS_DIR"/*/SKILL.md.pre-switch-target; do
    [ -e "$b" ] && run "rm -f '$b'"
  done
  log "  done removing .pre-switch backups."
}

precheck_deps() {        # dependency precheck (fail-closed style: clear warnings on missing, no silent fallback)
  local miss=0
  _need() { command -v "$1" >/dev/null 2>&1 || { log "  ⚠️ missing $1 — $2"; miss=$((miss + 1)); }; }
  log "dependency precheck (missing items only warn; for how to install, see the Ubuntu section of docs/INSTALL):"
  _need node "runtime (recommend nvm to install Node 22+)"
  _need pnpm "monorepo install/build (corepack enable)"
  _need python3 "ops / cron / yaml parsing"
  _need git "source"
  _need tmux "workshop multi-pane"
  command -v uv >/dev/null 2>&1 || [ -x "$HOME/.local/bin/uv" ] || { log "  ⚠️ missing uv — venv for the python MCPs (hkprop/ibkr)"; miss=$((miss + 1)); }
  [ "$ACTIVE_KIND" = "lark" ] && _need lark-cli "lark daemon inbound polling (must be authenticated)"
  if [ "$miss" -eq 0 ]; then log "  OK all dependencies present"; else log "  ⚠️ ${miss} dependency(ies) missing (see above) — the related components will skip/fail; install them and re-run"; fi
}

main() {
  log "REPO        = $REPO_ROOT"
  log "RUNTIME_ROOT= $KA_HOME"
  log "RUNTIME     = $RUNTIME"
  [ "$DRY_RUN" = 1 ] && log "mode: DRY-RUN (print only, no changes)"
  [ -n "$ONLY" ] && log "deploy only: $ONLY"
  log "channel kind  = ${ACTIVE_KIND} (both daemons deployed; only this one started; persisted to config.yaml)"
  echo "----"
  precheck_deps
  echo "----"
  if [ "$DO_CLEANUP" = 1 ]; then do_cleanup_old; echo "----"; log "cleanup-old done."; return 0; fi
  deploy_ka
  deploy_node_mcp
  deploy_kb_mcp
  deploy_opennutrition
  deploy_python_mcp
  deploy_daemon
  deploy_lark_daemon
  deploy_hooks
  deploy_core_cli
  deploy_skills
  seed_config
  register_mcp
  switch_ka_link
  switch_cron
  switch_hooks
  switch_daemon
  switch_lark_daemon
  switch_skills
  echo "----"
  log "done. (P1.1 skeleton; component deploy logic filled in over P1.2–P1.6)"
}
main
