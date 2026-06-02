#!/bin/bash
# run-all-in-docker.sh — build the test image and run the full case suite,
# tee-ing the output to ops/tests/results/full-YYYYMMDD.log.
#
# Env:
#   FAIL_FAST=1  propagate to entrypoint (stop at first fail)
#   ONLY=<rx>    propagate to entrypoint (filter)
#   IMAGE=...    override docker image tag
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT"

RESULTS_DIR="$HERE/results"
mkdir -p "$RESULTS_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$RESULTS_DIR/full-${STAMP}.log"

IMAGE="${IMAGE:-ka-ops-tests:latest}"
FAIL_FAST="${FAIL_FAST:-0}"
ONLY="${ONLY:-}"

{
    echo "==> build $IMAGE"
    docker build -f ops/tests/Dockerfile -t "$IMAGE" . 2>&1
    echo
    echo "==> run (FAIL_FAST=$FAIL_FAST ONLY='$ONLY')"
    docker run --rm --init \
        -e FAIL_FAST="$FAIL_FAST" \
        -e ONLY="$ONLY" \
        "$IMAGE" 2>&1
} | tee "$LOG"

rc="${PIPESTATUS[0]}"
echo
echo "log saved: $LOG"
exit "$rc"
