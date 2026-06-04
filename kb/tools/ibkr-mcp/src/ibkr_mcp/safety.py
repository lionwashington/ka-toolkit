"""Read-Only safety enforcement.

Four layered guarantees ensure this MCP server can never place a trade:

1. **No order imports** in any source file (verified by ``scripts/check-readonly.sh``).
2. **Loopback only**: refuse to start unless ``IBKR_HOST`` is loopback.
3. **Explicit trading flag**: ``IBKR_ALLOW_TRADING`` MUST be unset/false.
4. **User-side**: IB Gateway must have "Read-Only API" checked
   (documented in the setup guide; we can't programmatically verify).

``enforce_readonly()`` is called from ``server.main()`` at process startup
and exits with code 2 if any of (2) or (3) fails.
"""

from __future__ import annotations

import os
import sys


def enforce_readonly() -> None:
    """Validate environment for read-only operation.

    Exits the process with code 2 if any guarantee is violated.
    """
    # Guarantee 3: explicit trading flag must be unset or false
    allow = os.environ.get("IBKR_ALLOW_TRADING", "").strip().lower()
    if allow in ("1", "true", "yes", "on"):
        print(
            "FATAL: IBKR_ALLOW_TRADING is set. This MCP server is Read-Only "
            "by design and refuses to start with trading enabled.",
            file=sys.stderr,
        )
        sys.exit(2)

    # Guarantee 2: loopback only
    host = os.environ.get("IBKR_HOST", "127.0.0.1").strip()
    if host not in ("127.0.0.1", "localhost", "::1"):
        print(
            f"FATAL: IBKR_HOST={host!r} is not a loopback address. "
            "This MCP server only connects to a local IB Gateway.",
            file=sys.stderr,
        )
        sys.exit(2)
