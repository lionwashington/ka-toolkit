#!/bin/bash
# Verifies the single-source-of-truth channel-daemon resolution:
#   - config.yaml `channel_kind` picks the daemon (telegram|lark; default telegram)
#   - the daemon dir is <kind>-daemon
#   - the port comes from the active daemon's config.json `http_port` (NOT hardcoded)
#   - an invalid channel_kind is fail-closed (non-zero, no silent default)
#   - install.sh --channel-kind validates + persists channel_kind into config.yaml
#     (run in an isolated fake runtime root — never touches a real machine)
set -euo pipefail

REPO="${REPO:-/repo}"
COMMON="$REPO/shared/ops/common.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# Run a common.sh helper with controlled env. KA_HOME = the fixture home ($3) —
# the unified single root — so ka_daemon_dir resolves to $KA_HOME/channels/<kind>-daemon
# exactly as the runtime does. common.sh is sourced via its explicit repo path.
runh() {  # $1=helper expr  $2=config.yaml path  $3=KA_HOME (fixture home)
    KA_HOME="$3" KA_CONFIG="$2" HOME="$3" bash -c "source '$COMMON' 2>/dev/null; $1"
}

echo "[1/6] no config → telegram / telegram-daemon / 9877 (fallback)"
h="$TMP/h1"; mkdir -p "$h"
[ "$(runh ka_channel_kind /nonexistent "$h")" = "telegram" ] || { echo "FAIL: kind default"; exit 1; }
case "$(runh ka_daemon_dir /nonexistent "$h")" in */telegram-daemon) ;; *) echo "FAIL: dir not telegram-daemon"; exit 1;; esac
[ "$(runh ka_channel_port /nonexistent "$h")" = "9877" ] || { echo "FAIL: port fallback"; exit 1; }
echo "    ok"

echo "[2/6] channel_kind: lark → lark / lark-daemon"
h="$TMP/h2"; mkdir -p "$h"; cfg="$h/config.yaml"; printf 'channel_kind: lark\n' > "$cfg"
[ "$(runh ka_channel_kind "$cfg" "$h")" = "lark" ] || { echo "FAIL: kind lark"; exit 1; }
case "$(runh ka_daemon_dir "$cfg" "$h")" in */lark-daemon) ;; *) echo "FAIL: dir not lark-daemon"; exit 1;; esac
echo "    ok"

echo "[3/6] port read from the daemon's config.json http_port (not hardcoded)"
mkdir -p "$h/channels/lark-daemon"
printf '{\n  "http_port": 9999\n}\n' > "$h/channels/lark-daemon/config.json"
[ "$(runh ka_channel_port "$cfg" "$h")" = "9999" ] || { echo "FAIL: port not read from config.json"; exit 1; }
echo "    ok"

echo "[4/6] invalid channel_kind → fail-closed (non-zero)"
h="$TMP/h4"; mkdir -p "$h"; printf 'channel_kind: discord\n' > "$h/config.yaml"
if runh ka_channel_kind "$h/config.yaml" "$h" >/dev/null 2>&1; then
    echo "FAIL: invalid kind was accepted"; exit 1
fi
echo "    ok"

echo "[5/6] install --channel-kind=lark --only config persists channel_kind (isolated)"
rt="$TMP/rt5"
KA_HOME="$rt" bash "$REPO/install.sh" --channel-kind=lark --only config >/dev/null 2>&1 || true
grep -qE '^channel_kind:[[:space:]]*lark$' "$rt/config.yaml" \
    || { echo "FAIL: install did not persist channel_kind=lark"; cat "$rt/config.yaml" 2>/dev/null; exit 1; }
echo "    ok"

echo "[6/6] install --channel-kind=bogus is rejected (non-zero)"
rt="$TMP/rt6"
if KA_HOME="$rt" bash "$REPO/install.sh" --channel-kind=bogus --only config >/dev/null 2>&1; then
    echo "FAIL: bogus channel-kind was accepted"; exit 1
fi
echo "    ok"

echo "26-channel-kind OK"
