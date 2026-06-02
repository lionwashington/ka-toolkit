"""HTTP client for 28Hse.com.

Polite scrape settings:
  - Real desktop User-Agent (no spoofing as Googlebot etc.)
  - 1 req/sec global rate limit
  - 10s timeout, retry once on 5xx / network error
  - Conditional caching not implemented (V2)
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://www.28hse.com"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Safari/605.1.15 "
    "hkprop-mcp/0.1 (personal-use)"
)
DEFAULT_TIMEOUT_S = 15.0
DEFAULT_MIN_REQUEST_INTERVAL_S = 1.0
DEFAULT_LANG = "en"  # 28Hse supports en/zh-hk; en URLs are stable


class FetchError(RuntimeError):
    """Raised when a fetch fails after retries."""


class HKPropClient:
    """Singleton-ish httpx wrapper with rate-limit + retry."""

    def __init__(self) -> None:
        self.base_url = os.environ.get("HKPROP_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
        self.lang = os.environ.get("HKPROP_LANG", DEFAULT_LANG)
        self.timeout = float(os.environ.get("HKPROP_TIMEOUT_S", DEFAULT_TIMEOUT_S))
        self.min_interval = float(
            os.environ.get("HKPROP_MIN_REQUEST_INTERVAL_S", DEFAULT_MIN_REQUEST_INTERVAL_S)
        )
        self.user_agent = os.environ.get("HKPROP_USER_AGENT", DEFAULT_USER_AGENT)
        self._client: httpx.AsyncClient | None = None
        self._last_request_time: float = 0.0
        self._lock = asyncio.Lock()

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self.timeout,
                follow_redirects=True,
                headers={
                    "User-Agent": self.user_agent,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9,zh-HK;q=0.8",
                },
            )
        return self._client

    async def fetch(self, path: str, params: dict[str, Any] | None = None) -> str:
        """Fetch ``path`` and return HTML text. Rate-limited + retried once."""
        async with self._lock:
            # Throttle: wait until min_interval has elapsed since the last request.
            now = asyncio.get_event_loop().time()
            wait = self.min_interval - (now - self._last_request_time)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_request_time = asyncio.get_event_loop().time()

        client = await self._ensure_client()
        last_err: Exception | None = None
        for attempt in (1, 2):
            try:
                resp = await client.get(path, params=params)
                if resp.status_code == 200:
                    return resp.text
                if resp.status_code in (429, 500, 502, 503, 504) and attempt == 1:
                    logger.warning(
                        "28Hse %s returned %s on attempt %s, retrying after 2s",
                        path,
                        resp.status_code,
                        attempt,
                    )
                    await asyncio.sleep(2.0)
                    continue
                raise FetchError(f"{path}: HTTP {resp.status_code}")
            except (httpx.TimeoutException, httpx.NetworkError) as e:
                last_err = e
                if attempt == 1:
                    logger.warning(
                        "28Hse %s network error on attempt %s: %s — retrying after 2s",
                        path,
                        attempt,
                        e,
                    )
                    await asyncio.sleep(2.0)
                    continue
                raise FetchError(f"{path}: {type(e).__name__}: {e}") from e
        # Unreachable, but mypy/static-checker friendly:
        raise FetchError(f"{path}: {last_err!r}")

    async def close(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()


# Module-level singleton.
client = HKPropClient()
