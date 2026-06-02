#!/bin/bash
# ka wait-ready — new-shape signal recognition.
# Regression guard for the 2026-04-14 bug where wait-ready timed out against
# a fully-ready real CC pane because the heuristic only matched `│ >` and
# current CC TUI renders `❯` on its own line + a `ctrl+t to show tasks`
# status hint.
set -uo pipefail

REPO="${REPO:-/repo}"
KA="$REPO/bin/ka"
[ -x "$KA" ] || { echo "FAIL: $KA not executable"; exit 1; }

TMUX_BIN="${TMUX_BIN:-$(command -v tmux || echo /opt/homebrew/bin/tmux)}"
if [ ! -x "$TMUX_BIN" ]; then
    echo "SKIP: tmux not available"
    exit 0
fi

TMP="$(mktemp -d)"
cleanup() {
    "$TMUX_BIN" kill-session -t wr-caret  2>/dev/null || true
    "$TMUX_BIN" kill-session -t wr-status 2>/dev/null || true
    rm -rf "$TMP"
}
trap cleanup EXIT

run_case() {
    local label="$1" session="$2" fixture="$3"
    cat > "$TMP/workshop.yaml" <<EOF
session: $session
panes:
  - name: team-lead
    cwd: /tmp
    telegram: true
EOF
    export OPS_CONFIG="$TMP/workshop.yaml"

    "$TMUX_BIN" new-session -d -s "$session" -n team-lead -c /tmp \
        "cat '$fixture'; sleep 300"
    sleep 1

    set +e
    out="$(NO_COLOR=1 "$KA" wait-ready --timeout 8 --stable 1 -v 2>&1)"
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || { echo "FAIL [$label]: rc=$rc"; echo "$out"; exit 1; }
    echo "$out" | grep -q 'ready' \
        || { echo "FAIL [$label]: no ready message"; echo "$out"; exit 1; }
    "$TMUX_BIN" kill-session -t "$session" 2>/dev/null || true
}

echo "[1/2] recognizes new-shape prompt (❯ on own line)"
FAKE1="$TMP/caret.txt"
cat > "$FAKE1" <<'EOFX'
claude --resume initialized.
────────────────────────────────
❯
────────────────────────────────
EOFX
run_case caret wr-caret "$FAKE1"
echo "    ok"

echo "[2/2] recognizes status-line hint even without prompt glyph"
FAKE2="$TMP/status.txt"
cat > "$FAKE2" <<'EOFX'
claude boot complete.
  @main @freelancer → · shift+↓ to expand
  bypass permissions o · ctrl+t to show tasks
EOFX
run_case status wr-status "$FAKE2"
echo "    ok"

echo "wait-ready-signals OK"
