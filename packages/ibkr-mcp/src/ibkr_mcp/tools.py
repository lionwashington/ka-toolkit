"""Read-Only IBKR tool implementations.

Each function returns a JSON-serializable Python value. The MCP layer
(``server.py``) formats the result as a string for stdio transport.

WARNING: This module must NEVER import or call ib_async order-placement
classes or methods. The CI grep in ``scripts/check-readonly.sh`` enforces
this — the names themselves are intentionally omitted from this docstring
so the grep stays a single source of truth.
"""

from __future__ import annotations

import asyncio
import datetime as dt
from typing import Any

from ib_async import Stock

from .client import IBKRGatewayUnavailable, client

# How long to wait for a snapshot tick before falling back to historical close.
# Delayed market data feeds are slower than realtime (5-10s vs <1s) and some
# low-liquidity ETFs don't push intraday delayed ticks at all — they only show
# the prior session's close. ``reqTickersAsync`` has its own 11s internal cap;
# this value is a soft hint for streaming-mode polls.
SNAPSHOT_TIMEOUT_S = 12.0
PNL_FIRST_PUSH_S = 1.5
MAX_RANGE_DAYS_PER_REQUEST = 365


# ---------- helpers ----------


def _coerce_num(x: Any) -> float | None:
    """Convert a value to float, returning None for None/NaN/non-numeric."""
    if x is None:
        return None
    try:
        f = float(x)
    except (ValueError, TypeError):
        return None
    if f != f:  # NaN
        return None
    return f


# IBKR uses 0 and -1 as "no data available" sentinels for live tick fields
# (last/bid/ask). They are NOT valid prices — a stock cannot trade at $0 or
# -$1. Treat them as None so downstream change/change_pct math doesn't blow up.
# Close is reliable (it's the prior session's actual close), so we don't apply
# this sentinel filter there.
_TICK_NO_DATA_SENTINELS = (0.0, -1.0)


def _coerce_tick_price(x: Any) -> float | None:
    """Like ``_coerce_num`` but also rejects IBKR's 0 / -1 'no data' sentinels."""
    v = _coerce_num(x)
    if v is None or v in _TICK_NO_DATA_SENTINELS:
        return None
    return v


def _stock_contract(symbol: str) -> Stock:
    """Build a SMART/USD Stock contract from a ticker symbol."""
    sym = (symbol or "").strip().upper()
    if not sym or len(sym) > 20:
        raise ValueError(f"Invalid symbol: {symbol!r}")
    return Stock(sym, "SMART", "USD")


def _parse_date(s: str) -> dt.date:
    try:
        return dt.date.fromisoformat(s)
    except ValueError as e:
        raise ValueError(f"Invalid date {s!r}: expected YYYY-MM-DD") from e


# ---------- tools ----------


def _split_symbols(symbols: Any) -> list[str]:
    """Accept either a comma-separated string or an iterable of strings.

    Defensive: callers (the MCP server, ``portfolio_positions``, and direct
    Python users) pass different shapes. This normalizes both.
    """
    if isinstance(symbols, str):
        parts = symbols.split(",")
    else:
        parts = list(symbols)
    return [str(s).strip().upper() for s in parts if str(s).strip()]


async def _historical_close_fallback(ib: Any, contract: Any) -> tuple[float | None, str | None]:
    """Fetch the most recent daily close as a fallback.

    Returns (close_price, date_string) or (None, None) if no data available.
    Used when the delayed quote stream doesn't push intraday ticks (common
    for low-liquidity bond ETFs like VCSH / SGOV).
    """
    try:
        bars = await ib.reqHistoricalDataAsync(
            contract,
            endDateTime="",
            durationStr="5 D",
            barSizeSetting="1 day",
            whatToShow="TRADES",
            useRTH=True,
            formatDate=1,
        )
    except Exception:
        return None, None
    if not bars:
        return None, None
    last_bar = bars[-1]
    close = _coerce_num(last_bar.close)
    if close is None:
        return None, None
    return close, str(_bar_date(last_bar))


async def stock_quote(symbol: str) -> dict[str, Any]:
    """One-shot snapshot for one symbol.

    Uses ``reqTickersAsync`` (the ib_async-recommended snapshot helper) which
    waits up to ~11s for ticks and auto-cancels the subscription. If no tick
    arrives (typical for low-liquidity ETFs on the delayed feed), falls back
    to the most recent daily close via ``reqHistoricalDataAsync``.
    """
    ib = await client.get()
    contract = _stock_contract(symbol)
    qualified = await ib.qualifyContractsAsync(contract)
    if not qualified:
        raise ValueError(f"Symbol {symbol!r} not found")
    c = qualified[0]

    tickers = await ib.reqTickersAsync(c, regulatorySnapshot=False)
    ticker = tickers[0] if tickers else None
    return await _build_quote_from_ticker(ib, c, ticker)


async def _build_quote_from_ticker(ib: Any, c: Any, ticker: Any) -> dict[str, Any]:
    """Build a quote dict from a Ticker, with historical-close fallback.

    Live tick fields (last/bid/ask) are passed through ``_coerce_tick_price``
    which rejects IBKR's 0 / -1 'no data' sentinels — common on the delayed
    feed when the market is closed or the symbol has no intraday liquidity.
    """
    last = _coerce_tick_price(ticker.last) if ticker is not None else None
    bid = _coerce_tick_price(ticker.bid) if ticker is not None else None
    ask = _coerce_tick_price(ticker.ask) if ticker is not None else None
    close = _coerce_num(ticker.close) if ticker is not None else None

    fallback_date: str | None = None
    if last is None and close is None:
        fb_close, fb_date = await _historical_close_fallback(ib, c)
        if fb_close is not None:
            close = fb_close
            fallback_date = fb_date

    # change/change_pct are meaningful only when there's a *live* tick to
    # compare against the prior close. If last is None (no current data),
    # return None for both — returning 0.0 would falsely imply "no movement"
    # when the truth is "we don't know."
    change: float | None = None
    change_pct: float | None = None
    if last is not None and close is not None and close != 0:
        change = last - close
        change_pct = change / close * 100.0
    quote: dict[str, Any] = {
        "symbol": c.symbol,
        "currency": c.currency,
        "last": last,
        "bid": bid,
        "ask": ask,
        "close": close,
        "change": change,
        "change_pct": change_pct,
        "data_type": client.market_data_type_label,
    }
    if fallback_date is not None:
        quote["note"] = (
            f"No intraday tick on {client.market_data_type_label} feed; "
            f"`close` is the daily close from {fallback_date}."
        )
    return quote


async def stock_quotes(symbols: Any) -> list[dict[str, Any]]:
    """Snapshots for many symbols, concurrently.

    Accepts either a comma-separated string (``'NVDA,VTI,QQQ'``) or any
    iterable of tickers — both shapes are normalized internally.

    Each result includes ``data_type`` indicating realtime / delayed / frozen.
    Failed lookups produce an ``error`` field instead of price fields.
    """
    syms = _split_symbols(symbols)
    if not syms:
        return []
    results = await asyncio.gather(
        *[stock_quote(s) for s in syms], return_exceptions=True
    )
    out: list[dict[str, Any]] = []
    label = client.market_data_type_label
    for sym, r in zip(syms, results):
        if isinstance(r, Exception):
            out.append(
                {"symbol": sym, "error": f"{type(r).__name__}: {r}", "data_type": label}
            )
        else:
            out.append(r)
    return out


async def portfolio_positions() -> list[dict[str, Any]]:
    """All open positions with current price and unrealized P&L."""
    ib = await client.get()
    positions = ib.positions()
    out: list[dict[str, Any]] = []
    # Fetch current prices concurrently for STK positions.
    stk_symbols = [p.contract.symbol for p in positions if p.contract.secType == "STK"]
    price_map: dict[str, float | None] = {}
    if stk_symbols:
        quotes = await stock_quotes(stk_symbols)
        for q in quotes:
            price_map[q["symbol"]] = q.get("last") or q.get("close")
    label = client.market_data_type_label
    for p in positions:
        cur = price_map.get(p.contract.symbol)
        cur_num = _coerce_num(cur)
        out.append(
            {
                "account": p.account,
                "symbol": p.contract.symbol,
                "sec_type": p.contract.secType,
                "currency": p.contract.currency,
                "position": p.position,
                "avg_cost": p.avgCost,
                "current_price": cur_num,
                "market_value": (cur_num * p.position) if cur_num is not None else None,
                "unrealized_pnl": (
                    (cur_num - p.avgCost) * p.position if cur_num is not None else None
                ),
                "price_data_type": label,
            }
        )
    return out


async def portfolio_pnl() -> dict[str, Any]:
    """Real-time P&L (daily / unrealized / realized) for the primary account."""
    ib = await client.get()
    accounts = ib.managedAccounts()
    if not accounts:
        raise IBKRGatewayUnavailable(
            "No managed accounts found. Is IB Gateway logged in?"
        )
    account = accounts[0]
    pnl = ib.reqPnL(account)
    # First push arrives after ~1s. Wait briefly.
    await asyncio.sleep(PNL_FIRST_PUSH_S)
    return {
        "account": account,
        "daily_pnl": _coerce_num(pnl.dailyPnL),
        "unrealized_pnl": _coerce_num(pnl.unrealizedPnL),
        "realized_pnl": _coerce_num(pnl.realizedPnL),
    }


async def historical_price(symbol: str, date: str) -> dict[str, Any]:
    """Daily OHLCV for one calendar date (YYYY-MM-DD).

    Returns the bar matching ``date`` if available, else the most recent bar
    at or before ``date``.
    """
    ib = await client.get()
    contract = _stock_contract(symbol)
    qualified = await ib.qualifyContractsAsync(contract)
    if not qualified:
        raise ValueError(f"Symbol {symbol!r} not found")
    c = qualified[0]
    target = _parse_date(date)

    end_str = (target + dt.timedelta(days=1)).strftime("%Y%m%d 23:59:59 US/Eastern")
    bars = await ib.reqHistoricalDataAsync(
        c,
        endDateTime=end_str,
        durationStr="5 D",  # buffer for non-trading days
        barSizeSetting="1 day",
        whatToShow="TRADES",
        useRTH=True,
        formatDate=1,
    )
    if not bars:
        raise ValueError(f"No historical data for {c.symbol} near {date}")
    # Prefer exact match; else most recent bar at or before target.
    exact = [b for b in bars if _bar_date(b) == target]
    bar = exact[0] if exact else max(
        (b for b in bars if _bar_date(b) <= target), key=_bar_date, default=bars[-1]
    )
    return {
        "symbol": c.symbol,
        "date": str(_bar_date(bar)),
        "open": _coerce_num(bar.open),
        "high": _coerce_num(bar.high),
        "low": _coerce_num(bar.low),
        "close": _coerce_num(bar.close),
        "volume": _coerce_num(bar.volume),
    }


async def historical_range(
    symbol: str, from_date: str, to_date: str
) -> list[dict[str, Any]]:
    """Daily OHLCV bars between two dates inclusive.

    Splits into multiple requests for ranges > 1 year.
    """
    ib = await client.get()
    contract = _stock_contract(symbol)
    qualified = await ib.qualifyContractsAsync(contract)
    if not qualified:
        raise ValueError(f"Symbol {symbol!r} not found")
    c = qualified[0]
    from_dt = _parse_date(from_date)
    to_dt = _parse_date(to_date)
    if to_dt < from_dt:
        raise ValueError("to_date must be >= from_date")

    all_bars: list[Any] = []
    cur_end = to_dt
    while cur_end >= from_dt:
        chunk_start = max(from_dt, cur_end - dt.timedelta(days=MAX_RANGE_DAYS_PER_REQUEST - 1))
        chunk_days = (cur_end - chunk_start).days + 1
        end_str = (cur_end + dt.timedelta(days=1)).strftime(
            "%Y%m%d 23:59:59 US/Eastern"
        )
        bars = await ib.reqHistoricalDataAsync(
            c,
            endDateTime=end_str,
            durationStr=f"{chunk_days} D",
            barSizeSetting="1 day",
            whatToShow="TRADES",
            useRTH=True,
            formatDate=1,
        )
        all_bars.extend(bars)
        if chunk_start == from_dt:
            break
        cur_end = chunk_start - dt.timedelta(days=1)

    # Dedup and filter to range.
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for b in sorted(all_bars, key=_bar_date):
        d = _bar_date(b)
        if d < from_dt or d > to_dt:
            continue
        key = str(d)
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "date": key,
                "open": _coerce_num(b.open),
                "high": _coerce_num(b.high),
                "low": _coerce_num(b.low),
                "close": _coerce_num(b.close),
                "volume": _coerce_num(b.volume),
            }
        )
    return out


def _bar_date(bar: Any) -> dt.date:
    """Normalize a bar's date field (could be date, datetime, or string)."""
    d = bar.date
    if isinstance(d, dt.datetime):
        return d.date()
    if isinstance(d, dt.date):
        return d
    return dt.date.fromisoformat(str(d)[:10])
