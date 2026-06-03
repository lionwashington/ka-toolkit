#!/bin/bash
# run.sh — build the test image and run the suite.
# Builds from REPO ROOT so the image has both ops/ and scheduled-tasks/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$OPS_DIR/.." && pwd)"

cd "$REPO_ROOT"

IMAGE="ka-ops-tests:latest"

# The distill-bg tests (21/22/23) exercise the real distill scripts, which call
# the @ka/core CLI bundles. Build them on the host first so the Dockerfile can
# COPY them in (they're standalone node bundles → platform-independent).
if [ ! -f packages/core/dist/jsonl-reader-cli.js ] || \
   [ ! -f packages/core/dist/distill-result-parser-cli.js ]; then
    echo "==> building @ka/core CLI bundles (missing)"
    pnpm --filter @ka/core build
fi

echo "==> building $IMAGE (context: $REPO_ROOT)"
docker build -f ops/tests/Dockerfile -t "$IMAGE" .

echo "==> running suite"
docker run --rm --init "$IMAGE"
