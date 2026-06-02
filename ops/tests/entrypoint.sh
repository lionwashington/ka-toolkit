#!/bin/bash
# entrypoint.sh — run every ops/tests/cases/*.sh.
# Env:
#   FAIL_FAST=1  stop at first failing case (default: continue, report all)
#   ONLY=<regex> only run cases whose basename matches the regex
set -u

# Skip the post-start wait-for-lead-ready probe in all cases — the suite uses
# a fake claude binary that never renders CC's ready signals, so the real
# probe would time out for nothing. Individual cases can still opt in by
# exporting KA_WAIT_READY_TIMEOUT=<seconds>.
export KA_WAIT_READY_TIMEOUT="${KA_WAIT_READY_TIMEOUT:-0}"

CASES_DIR="/repo/ops/tests/cases"
PASS=0
FAIL=0
FAILED_NAMES=()
FAIL_FAST="${FAIL_FAST:-0}"
ONLY="${ONLY:-}"

echo "==> ops test suite"
echo "    tmux:    $(tmux -V)"
echo "    python3: $(python3 --version)"
echo

for case_file in "$CASES_DIR"/*.sh; do
    name="$(basename "$case_file")"
    if [ -n "$ONLY" ] && ! [[ "$name" =~ $ONLY ]]; then
        continue
    fi
    echo "--- $name ---"
    if bash "$case_file"; then
        echo "    PASS"
        PASS=$((PASS + 1))
    else
        echo "    FAIL"
        FAIL=$((FAIL + 1))
        FAILED_NAMES+=("$name")
        if [ "$FAIL_FAST" = "1" ]; then
            echo "==> FAIL_FAST=1: stopping at first failure"
            break
        fi
    fi
    # Clean tmux state between cases
    tmux kill-server 2>/dev/null || true
    rm -rf /tmp/tmux-test/* 2>/dev/null || true
    rm -f /tmp/claude-*.log 2>/dev/null || true
    echo
done

echo "==> Results: $PASS pass, $FAIL fail"
if [ "$FAIL" -gt 0 ]; then
    printf '    failed: %s\n' "${FAILED_NAMES[@]}"
    exit 1
fi
