"""IBKR Read-Only MCP server (stdio transport).

Exposes six tools:
  - stock_quote(symbol)
  - stock_quotes(symbols)
  - portfolio_positions()
  - portfolio_pnl()
  - historical_price(symbol, date)
  - historical_range(symbol, from_date, to_date)

All errors are returned as plain text so the LLM can read them. The
gateway-unavailable case is returned with a stable ``IBKR_GATEWAY_NOT_RUNNING``
prefix so callers can detect it and fall back to mcp__market-data__*.
"""

from __future__ import annotations

import json
import logging
import sys

from mcp.server.fastmcp import FastMCP

from . import tools as t
from .client import IBKRGatewayUnavailable
from .safety import enforce_readonly

logger = logging.getLogger("ibkr_mcp")

mcp = FastMCP("ibkr")


def _fmt(obj: object) -> str:
    return json.dumps(obj, indent=2, default=str, ensure_ascii=False)


def _err(prefix: str, e: Exception) -> str:
    return f"{prefix}: {type(e).__name__}: {e}"


@mcp.tool()
async def stock_quote(symbol: str) -> str:
    """Real-time stock quote from IBKR.

    Returns last / bid / ask / close / change / change_pct for the given
    US stock ticker (SMART exchange, USD).

    Args:
        symbol: ticker symbol (e.g. NVDA, AAPL, SPY).
    """
    try:
        return _fmt(await t.stock_quote(symbol))
    except IBKRGatewayUnavailable as e:
        return f"IBKR_GATEWAY_NOT_RUNNING: {e}"
    except Exception as e:  # noqa: BLE001
        return _err("Error", e)


@mcp.tool()
async def stock_quotes(symbols: str) -> str:
    """Real-time quotes for multiple US stocks at once.

    Args:
        symbols: comma-separated tickers (e.g. NVDA,SPY,QQQ,VTI).
    """
    try:
        syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
        if not syms:
            return "Error: no symbols provided"
        return _fmt(await t.stock_quotes(syms))
    except IBKRGatewayUnavailable as e:
        return f"IBKR_GATEWAY_NOT_RUNNING: {e}"
    except Exception as e:  # noqa: BLE001
        return _err("Error", e)


@mcp.tool()
async def portfolio_positions() -> str:
    """All current IBKR positions with avg cost, current price, market value, unrealized P&L.

    Live market data is fetched for STK positions only.
    """
    try:
        return _fmt(await t.portfolio_positions())
    except IBKRGatewayUnavailable as e:
        return f"IBKR_GATEWAY_NOT_RUNNING: {e}"
    except Exception as e:  # noqa: BLE001
        return _err("Error", e)


@mcp.tool()
async def portfolio_pnl() -> str:
    """Real-time portfolio P&L (daily / unrealized / realized) for the primary account."""
    try:
        return _fmt(await t.portfolio_pnl())
    except IBKRGatewayUnavailable as e:
        return f"IBKR_GATEWAY_NOT_RUNNING: {e}"
    except Exception as e:  # noqa: BLE001
        return _err("Error", e)


@mcp.tool()
async def historical_price(symbol: str, date: str) -> str:
    """Daily OHLCV bar for a single calendar date.

    Args:
        symbol: ticker (e.g. NVDA).
        date: ISO date YYYY-MM-DD. If the market was closed that day, returns
              the most recent prior trading day.
    """
    try:
        return _fmt(await t.historical_price(symbol, date))
    except IBKRGatewayUnavailable as e:
        return f"IBKR_GATEWAY_NOT_RUNNING: {e}"
    except Exception as e:  # noqa: BLE001
        return _err("Error", e)


@mcp.tool()
async def historical_range(symbol: str, from_date: str, to_date: str) -> str:
    """Daily OHLCV bars for a date range, inclusive.

    Args:
        symbol: ticker.
        from_date: ISO date YYYY-MM-DD (inclusive).
        to_date: ISO date YYYY-MM-DD (inclusive).
    """
    try:
        return _fmt(await t.historical_range(symbol, from_date, to_date))
    except IBKRGatewayUnavailable as e:
        return f"IBKR_GATEWAY_NOT_RUNNING: {e}"
    except Exception as e:  # noqa: BLE001
        return _err("Error", e)


def main() -> None:
    logging.basicConfig(
        level=logging.WARNING,
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    enforce_readonly()
    mcp.run()
