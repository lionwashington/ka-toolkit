#!/bin/bash
# rehearse.sh — simulate an OLD (pre-gen3) deployed runtime, then run the owner's
# 5-step gen3 live-switch migration end-to-end and assert the new env is wired up.
# Runs INSIDE the rehearsal container ($HOME=/root). Never touches a real machine.
set -uo pipefail
KA="$HOME/.knowledge-assistant"
export KA_HOME="$KA"
pass=0; fail=0
ok(){ echo "  PASS $1"; pass=$((pass+1)); }
no(){ echo "  FAIL $1"; fail=$((fail+1)); }
hr(){ echo; echo "=== $1 ==="; }

hr "Simulate OLD (pre-gen3) environment"
# OLD deployed runtime: the runtime/ wrapper tree (stub content)
mkdir -p "$KA"/runtime/{bin,ops,mcp/kb,mcp/market,daemon,hooks,core-cli,skills}
echo '#!/bin/sh' > "$KA/runtime/bin/ka"; echo 'echo old-ka' >> "$KA/runtime/bin/ka"; chmod +x "$KA/runtime/bin/ka"
# OLD config lived at the KA root (not config/)
cat > "$KA/config.yaml" <<'Y'
knowledge_base_path: /root/kb-data
channel_kind: telegram
Y
cat > "$KA/secrets.yaml" <<'Y'
amap_api_key: OLD_AMAP_KEY
Y
cat > "$KA/workshop.yaml" <<'Y'
mates:
  main: { cwd: /root, default: true }
Y
echo 'jobs: []' > "$KA/cron.yaml"
# OLD per-daemon config.json + .env (the full-B change removes these)
mkdir -p "$HOME/.telegram-channel"
echo '{ "http_port": 9877, "owner_chat_id": "111222333" }' > "$HOME/.telegram-channel/config.json"
echo 'TELEGRAM_BOT_TOKEN=123456:FAKE_OLD_TOKEN' > "$HOME/.telegram-channel/.env"
echo '{"offset":42,"channel_numbers":{}}' > "$HOME/.telegram-channel/state.json"
# OLD CC-side pointers (what --switch must repoint)
mkdir -p "$HOME/.claude" "$HOME/.local/bin" "$HOME/.claude/skills"
cat > "$HOME/.claude.json" <<'J'
{ "mcpServers": {
  "knowledge-assistant": {"command":"node","args":["/root/.knowledge-assistant/runtime/mcp/kb/index.mjs"]},
  "market-data": {"command":"node","args":["/root/.knowledge-assistant/runtime/mcp/market/index.mjs"]}
} }
J
cat > "$HOME/.claude/settings.json" <<'J'
{ "hooks": { "Stop": [ { "hooks": [ {"type":"command","command":"node /root/.knowledge-assistant/runtime/hooks/capture-hook.js"} ] } ] } }
J
ln -sf "$KA/runtime/bin/ka" "$HOME/.local/bin/ka"
echo "  old env: runtime/ wrapper + root config.yaml/secrets.yaml + ~/.telegram-channel{config.json,.env} + claude.json/settings.json/ka-link"

hr "Step 1 — snapshot OLD structure (names only, for cleanup reference)"
find "$KA" "$HOME/.telegram-channel" -printf '%y %p\n' 2>/dev/null | sort > "$HOME/old-manifest.txt"
echo "  manifest: $(wc -l < "$HOME/old-manifest.txt") entries → ~/old-manifest.txt"

hr "Step 2 — full plain install (new by-part tree alongside old)"
cd /src
./install.sh --channel-kind=telegram >/tmp/install.log 2>&1
echo "  (install.log tail:)"; tail -6 /tmp/install.log | sed 's/^/    /'
[ -f "$KA/shared/bin/ka" ] && ok "new shared/bin/ka deployed" || no "new shared/bin/ka missing"
[ -d "$KA/channels/telegram-daemon" ] && ok "new channels/telegram-daemon deployed" || no "telegram-daemon missing"
[ -x "$KA/runtime/bin/ka" ] && ok "OLD runtime/bin/ka still present (coexist, untouched)" || no "OLD runtime clobbered"
[ -f "$KA/config.yaml" ] && grep -q OLD_AMAP_KEY "$KA/secrets.yaml" && ok "OLD root config.yaml/secrets.yaml untouched" || no "OLD root config disturbed"

hr "Step 3 — migrate config → config/ + add new channels.<kind> schema"
mkdir -p "$KA/config"
# cp (not mv) so the old root copies survive as a backup until verified
cp "$KA/config.yaml"   "$KA/config/config.yaml"
cp "$KA/secrets.yaml"  "$KA/config/secrets.yaml"
cp "$KA/workshop.yaml" "$KA/config/workshop.yaml"
cp "$KA/cron.yaml"     "$KA/config/cron.yaml"
# new schema: port → config.yaml ; token/owner → secrets.yaml (taken from old config.json/.env)
cat >> "$KA/config/config.yaml" <<'Y'
channels:
  telegram:
    port: 9877
Y
cat >> "$KA/config/secrets.yaml" <<'Y'
channels:
  telegram:
    token: "123456:FAKE_OLD_TOKEN"
    owner_chat_id: "111222333"
Y
grep -q 'token: "123456' "$KA/config/secrets.yaml" && ok "config migrated to config/ with channels.telegram secret schema" || no "config migration failed"

hr "Step 4 — stop old daemon/workshop (none live in container — noop)"
echo "  (no live daemon/workshop in the container)"

hr "Step 5 — ./install.sh --switch (repoint pointers + start new daemon)"
./install.sh --switch --channel-kind=telegram >/tmp/switch.log 2>&1
echo "  (switch.log tail:)"; tail -10 /tmp/switch.log | sed 's/^/    /'
grep -q '/kb/mcp/kb/index.mjs' "$HOME/.claude.json" && ok "~/.claude.json MCP repointed → kb/mcp/*" || no "claude.json MCP not repointed"
[ "$(readlink "$HOME/.local/bin/ka")" = "$KA/shared/bin/ka" ] && ok "ka symlink → new shared/bin/ka" || no "ka symlink not switched (=$(readlink "$HOME/.local/bin/ka"))"
grep -q '/kb/hooks' "$HOME/.claude/settings.json" && ok "~/.claude/settings.json hooks → kb/hooks" || no "hooks not repointed"
grep -q '.pre-switch' <(ls -a "$HOME") 2>/dev/null; ls "$HOME"/.claude.json.pre-switch-* >/dev/null 2>&1 && ok "claude.json .pre-switch backup written" || no "no claude.json backup"

hr "Verify — new telegram daemon reads migrated config/secrets (full-B)"
# With a NON-empty (fake) token the daemon passes fail-closed and tries to start
# (it may later fail Telegram getUpdates on the fake token — that's fine; we only
# prove it READ config/secrets and got past the fail-closed gate).
"$KA/channels/telegram-daemon/start.sh" >/dev/null 2>&1 || true
sleep 3
DLOG="$KA/channels/telegram-daemon/daemon.stdout.log"
if curl -s "127.0.0.1:9877/api/status" >/dev/null 2>&1; then
  ok "daemon HTTP up on 9877 (read config.yaml port + secrets token)"
elif [ -f "$DLOG" ] && grep -qiE 'getUpdates|401|unauthorized|telegram' "$DLOG"; then
  ok "daemon passed fail-closed + read config (reached Telegram getUpdates; fake token rejected as expected)"
else
  echo "    daemon.stdout.log:"; [ -f "$DLOG" ] && tail -8 "$DLOG" | sed 's/^/      /'
  no "daemon did not reach the start/config-read path"
fi

hr "Verify — fail-closed: EMPTY token must refuse to start"
"$KA/channels/telegram-daemon/stop.sh" >/dev/null 2>&1 || true; sleep 1
cp "$KA/config/secrets.yaml" "$KA/config/secrets.yaml.bak"
# blank the token value
python3 - <<PY
import re,io
p="$KA/config/secrets.yaml"
s=open(p).read().replace('123456:FAKE_OLD_TOKEN','')
open(p,'w').write(s)
PY
"$KA/channels/telegram-daemon/start.sh" >/dev/null 2>&1 || true; sleep 3
if curl -s "127.0.0.1:9877/api/status" >/dev/null 2>&1; then
  no "daemon STARTED with empty token — fail-closed is BROKEN"
else
  ok "fail-closed honored: empty token → daemon refused to start"
fi
mv "$KA/config/secrets.yaml.bak" "$KA/config/secrets.yaml"
"$KA/channels/telegram-daemon/stop.sh" >/dev/null 2>&1 || true

hr "Step 6 — cleanup old (manifest-guided), new tree must survive"
./install.sh --cleanup-old >/tmp/cleanup.log 2>&1 || true
# --cleanup-old removes ~/.telegram-channel + .pre-switch backups; the old runtime/
# wrapper + old root config are removed by hand (using the step-1 manifest).
rm -rf "$KA/runtime" "$KA/config.yaml" "$KA/secrets.yaml" "$KA/workshop.yaml" "$KA/cron.yaml"
[ ! -d "$KA/runtime" ] && ok "old runtime/ wrapper removed" || no "old runtime/ remains"
[ ! -d "$HOME/.telegram-channel" ] && ok "old ~/.telegram-channel removed by --cleanup-old" || no "old daemon dir remains"
[ -f "$KA/shared/bin/ka" ] && [ -f "$KA/config/secrets.yaml" ] && ok "new tree + config/ intact after cleanup" || no "new tree damaged by cleanup"

echo
echo "================ REHEARSAL: ${pass} passed, ${fail} failed ================"
[ "$fail" -eq 0 ]
