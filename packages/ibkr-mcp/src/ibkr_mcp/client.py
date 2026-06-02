"""Singleton IBKR connection manager.

One persistent ``ib_async.IB`` per server process. Lazy connect on first
tool call. Reconnects on dropped connection (with a single retry).
"""

from __future__ import annotations

import asyncio
import logging
import os

from ib_async import IB

logger = logging.getLogger(__name__)


class IBKRGatewayUnavailable(RuntimeError):
    """Raised when IB Gateway can't be reached or isn't logged in."""


# Market data type passed to IB.reqMarketDataType:
#   1 = real-time (requires paid subscription)
#   2 = frozen (last value at market close)
#   3 = delayed (~15 min, FREE — IBKR default for unsubscribed accounts)
#   4 = delayed-frozen
MARKET_DATA_TYPE_LABEL: dict[int, str] = {
    1: "realtime",
    2: "frozen",
    3: "delayed",
    4: "delayed_frozen",
}


class IBKRClient:
    """Thread-/coroutine-safe singleton wrapper around ``ib_async.IB``."""

    def __init__(self) -> None:
        self._ib: IB | None = None
        self._lock = asyncio.Lock()
        # Defaults: Paper trading on loopback with a fixed clientId.
        self.host = os.environ.get("IBKR_HOST", "127.0.0.1")
        self.port = int(os.environ.get("IBKR_PORT", "4002"))
        self.client_id = int(os.environ.get("IBKR_CLIENT_ID", "17"))
        self.connect_timeout = float(os.environ.get("IBKR_CONNECT_TIMEOUT", "10"))
        # Default to type 3 (delayed) so the server works with unsubscribed
        # IBKR accounts out of the box. Override via env when the account has
        # a real-time market data subscription.
        self.market_data_type = int(os.environ.get("IBKR_MARKET_DATA_TYPE", "3"))

    async def get(self) -> IB:
        """Return a connected ``IB`` instance, connecting lazily if needed."""
        async with self._lock:
            if self._ib is not None and self._ib.isConnected():
                return self._ib
            self._ib = IB()
            try:
                await self._ib.connectAsync(
                    self.host,
                    self.port,
                    clientId=self.client_id,
                    timeout=self.connect_timeout,
                    readonly=True,  # ib_async client-side read-only flag
                )
            except (ConnectionRefusedError, asyncio.TimeoutError, OSError) as e:
                self._ib = None
                raise IBKRGatewayUnavailable(
                    f"IBKR Gateway not reachable on {self.host}:{self.port}. "
                    f"Ensure IB Gateway is running and logged in. "
                    f"({type(e).__name__}: {e})"
                ) from e
            except Exception as e:  # pragma: no cover - defensive
                self._ib = None
                raise IBKRGatewayUnavailable(
                    f"Unexpected error connecting to IBKR: {e}"
                ) from e
            # Set market data type once per connection. This is sticky for the
            # session: subsequent reqMktData calls will return delayed (or
            # whatever type was requested) without needing the flag each time.
            try:
                self._ib.reqMarketDataType(self.market_data_type)
            except Exception as e:  # pragma: no cover - defensive
                logger.warning(
                    "reqMarketDataType(%s) failed: %s", self.market_data_type, e
                )
            logger.info(
                "Connected to IBKR Gateway at %s:%s (clientId=%s, mktDataType=%s)",
                self.host,
                self.port,
                self.client_id,
                self.market_data_type,
            )
            return self._ib

    @property
    def market_data_type_label(self) -> str:
        return MARKET_DATA_TYPE_LABEL.get(
            self.market_data_type, f"type_{self.market_data_type}"
        )

    async def close(self) -> None:
        if self._ib is not None and self._ib.isConnected():
            self._ib.disconnect()
            self._ib = None


# Module-level singleton.
client = IBKRClient()
