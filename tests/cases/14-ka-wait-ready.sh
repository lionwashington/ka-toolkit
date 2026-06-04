#!/bin/bash
# ka wait-ready smoke tests.
# Covers:
#   1. rc=3 when the target session does not exist.
#   2. rc=0 when a pane already shows a ready-looking CC prompt and content
#      is stable (uses a fake pane — we can't boot real CC inside tests).
#   3. rc=1 when a pane keeps changing (prompt never idles).
set -uo pipefail

REPO="${REPO:-/repo}"
KA="$REPO/shared/bin/ka"
[ -x "$KA" ] || { echo "FAIL: $KA not executable"; exit 1; }

TMUX_BIN="${TMUX_BIN:-$(command -v tmux || echo /opt/homebrew/bin/tmux)}"
if [ ! -x "$TMUX_BIN" ]; then
    echo "SKIP: tmux not available at $TMUX_BIN"
    exit 0
fi

TMP="$(mktemp -d)"
cleanup() {
    "$TMUX_BIN" kill-session -t wr-ready 2>/dev/null || true
    "$TMUX_BIN" kill-session -t wr-busy 2>/dev/null || true
    rm -rf "$TMP"
}
trap cleanup EXIT

cat > "$TMP/workshop.yaml" <<'EOF'
session: wr-ready
mates:
  - name: team-lead
    cwd: /tmp
    main: true
EOF
export OPS_CONFIG="$TMP/workshop.yaml"

echo "[1/3] rc=3 when session does not exist"
set +e
out="$(NO_COLOR=1 bash "$REPO/workshop/ops/wait-ready.sh" --timeout 1 2>&1)"
rc=$?
set -e
[ "$rc" -eq 3 ] || { echo "FAIL: missing session should rc=3, got $rc"; echo "$out"; exit 1; }
echo "$out" | grep -q "not running" \
    || { echo "FAIL: expected 'not running' diagnostic"; echo "$out"; exit 1; }
echo "    ok"

echo "[2/3] rc=0 when pane already shows a ready-looking prompt"
# Fake "ready" screen: write lines containing the '│ >' marker, then idle.
FAKE="$TMP/fake-ready.txt"
cat > "$FAKE" <<'EOFX'
claude --resume initialized.
All hooks loaded. MCP servers ready.
╭────────────────────────────────────────────╮
│ >                                          │
╰────────────────────────────────────────────╯
EOFX

"$TMUX_BIN" new-session -d -s wr-ready -n team-lead -c /tmp "cat '$FAKE'; sleep 300"
sleep 1

set +e
out="$(NO_COLOR=1 bash "$REPO/workshop/ops/wait-ready.sh" --timeout 10 --stable 1 2>&1)"
rc=$?
set -e
[ "$rc" -eq 0 ] || { echo "FAIL: ready pane should rc=0, got $rc"; echo "$out"; exit 1; }
echo "$out" | grep -q 'ready' \
    || { echo "FAIL: expected 'ready' diagnostic"; echo "$out"; exit 1; }
echo "    ok"

"$TMUX_BIN" kill-session -t wr-ready 2>/dev/null || true

echo "[3/3] rc=1 when pane never idles (timeout)"
# Rewrite config to point at a new busy session so step 2 is independent.
cat > "$TMP/workshop.yaml" <<'EOF'
session: wr-busy
mates:
  - name: team-lead
    cwd: /tmp
    main: true
EOF

# Busy pane: prints a rotating timestamp forever — no CC-prompt marker present.
"$TMUX_BIN" new-session -d -s wr-busy -n team-lead -c /tmp \
    "while :; do date +%N; sleep 0.2; done"
sleep 1

set +e
out="$(NO_COLOR=1 bash "$REPO/workshop/ops/wait-ready.sh" --timeout 2 --stable 1 2>&1)"
rc=$?
set -e
[ "$rc" -eq 1 ] || { echo "FAIL: never-ready pane should rc=1, got $rc"; echo "$out"; exit 1; }
echo "$out" | grep -q 'timeout' \
    || { echo "FAIL: expected 'timeout' diagnostic"; echo "$out"; exit 1; }
echo "    ok"

echo "ka-wait-ready OK"
