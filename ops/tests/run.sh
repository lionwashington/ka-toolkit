#!/bin/bash
# run.sh — build the test image and run the suite.
# Builds from REPO ROOT so the image has both ops/ and scheduled-tasks/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$OPS_DIR/.." && pwd)"

cd "$REPO_ROOT"

IMAGE="ka-ops-tests:latest"

echo "==> building $IMAGE (context: $REPO_ROOT)"
docker build -f ops/tests/Dockerfile -t "$IMAGE" .

echo "==> running suite"
docker run --rm --init "$IMAGE"
