"""Read-only MCP server for Interactive Brokers (IBKR) API.

This package exposes IBKR market data, portfolio, and historical price tools
via the Model Context Protocol. It is Read-Only by design: it must not import
or call any order-placement code in ib_async. Four layered guarantees enforce
this contract; see ``ibkr_mcp.safety`` and ``scripts/check-readonly.sh``.
"""

__version__ = "0.1.0"
