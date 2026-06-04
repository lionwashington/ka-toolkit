#!/usr/bin/env bash
# Read-Only enforcement: grep for any forbidden order-placement code.
#
# Run from anywhere; resolves the package src/ dir from its own location.
# Exits 0 if clean, 1 if any forbidden pattern is found.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src"

if [ ! -d "$SRC" ]; then
  echo "FATAL: src/ not found at $SRC" >&2
  exit 1
fi

# Patterns that would indicate order-placement code.
# Use exact tokens (boundary-safe via grep -w where possible).
FORBIDDEN=(
  'placeOrder'
  'cancelOrder'
  'modifyOrder'
  'reqGlobalCancel'
  'bracketOrder'
  'oneCancelsAll'
  'MarketOrder\>'
  'LimitOrder\>'
  'StopOrder\>'
  'StopLimitOrder\>'
  '\<Order\>\s*\('
)

failed=0
for pattern in "${FORBIDDEN[@]}"; do
  matches=$(grep -rnE "$pattern" "$SRC" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "FORBIDDEN: pattern '$pattern' found:"
    echo "$matches" | sed 's/^/  /'
    failed=1
  fi
done

if [ $failed -ne 0 ]; then
  echo ""
  echo "Read-Only safety check FAILED."
  echo "This server must never import or call any order-placement code."
  exit 1
fi

echo "OK: Read-Only check passed (no order-placement code in $SRC)"
