"""Google Maps Directions integration — transit commute from listing → school.

V3 capability. Used to evaluate HK rental candidates against a daily commute.
Default destination is Victoria Harbour, Hong Kong — a neutral landmark;
override per call with the `school`/destination argument.

API key resolution priority:
    1. ``GOOGLE_MAPS_API_KEY`` env var (test/dev override)
    2. ``~/.knowledge-assistant/secrets.yaml`` key ``google_maps_api_key``

We hit the Directions API directly via httpx — no ``googlemaps`` Python SDK
needed. The Directions API accepts free-text origins and geocodes them
in-line, so for sources without lat/lng (Centanet) we pass the
``"{building}, {address}, Hong Kong"`` string and let Google resolve it.
"""

from __future__ import annotations

import logging
import os
import pathlib
from datetime import datetime, timedelta, timezone
from typing import Any, TypedDict

import httpx

logger = logging.getLogger(__name__)


DEFAULT_BASE_URL = "https://maps.googleapis.com/maps/api"
DEFAULT_TIMEOUT_S = 15.0
DEFAULT_SECRETS_PATH = pathlib.Path.home() / ".knowledge-assistant" / "secrets.yaml"

# Neutral, well-known HK landmark that Google geocodes cleanly. Callers should
# pass their own destination; this is only a demo fallback.
DEFAULT_DESTINATION = "Victoria Harbour, Hong Kong"

HK_TZ = timezone(timedelta(hours=8))


class CommuteResult(TypedDict, total=False):
    origin: dict[str, Any]
    destination: dict[str, Any]
    total_minutes: int
    walking_minutes: int
    transit_minutes: int
    transfers: int
    steps: list[dict[str, Any]]
    fare_hkd: float | None
    fare_currency: str
    departure_time: str
    arrival_time: str
    listing: dict[str, Any]


class CommuteError(RuntimeError):
    """Raised when commute computation fails (missing key, API error, no route)."""


# ---------- API key ----------


def _load_api_key() -> str:
    """Resolve Google Maps API key from env or secrets.yaml.

    Doing this lazily (not at import time) keeps tests hermetic — they can
    set ``GOOGLE_MAPS_API_KEY`` per-test without touching the real secrets
    file.
    """
    env = os.environ.get("GOOGLE_MAPS_API_KEY")
    if env and env.strip():
        return env.strip()

    path = pathlib.Path(
        os.environ.get("KA_SECRETS_PATH", str(DEFAULT_SECRETS_PATH))
    )
    if not path.exists():
        raise CommuteError(
            f"GOOGLE_MAPS_API_KEY not set and secrets file {path} not found. "
            "Either export the env var or add "
            "`google_maps_api_key: AIza...` to the secrets file."
        )

    # Flat YAML parser — secrets.yaml is one `key: value` per line.
    # Avoids adding pyyaml as a dependency for one trivial lookup.
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        if key.strip() == "google_maps_api_key":
            v = value.strip().strip('"').strip("'")
            if v:
                return v
    raise CommuteError(
        f"`google_maps_api_key` not found in {path}. "
        "Add a line: `google_maps_api_key: AIza...`"
    )


# ---------- Time handling ----------


def _next_weekday_8am(now: datetime | None = None) -> datetime:
    """Return the next Mon-Fri 08:00 in Hong Kong time.

    Used as the default departure when the caller doesn't specify one — a
    weekday 8 AM matches a typical school-commute window, so Google returns
    realistic transit schedules (not midnight-empty routes).
    """
    now = now or datetime.now(HK_TZ)
    candidate = now.replace(hour=8, minute=0, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    # 5 = Sat, 6 = Sun — push to Monday.
    while candidate.weekday() >= 5:
        candidate += timedelta(days=1)
    return candidate


def _parse_departure(departure_time: str | None) -> int:
    """Convert user-supplied departure to a UNIX timestamp.

    Accepts:
        - ``None`` → next weekday 08:00 HKT
        - ``"now"`` → current time
        - ISO 8601 string (with or without tz; bare time → assume HKT)
    """
    if departure_time is None:
        dt = _next_weekday_8am()
    elif departure_time == "now":
        dt = datetime.now(HK_TZ)
    else:
        s = departure_time.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=HK_TZ)
    return int(dt.timestamp())


# ---------- Origin selection ----------


def origin_from_listing(listing: dict[str, Any]) -> str:
    """Pick the best Directions API origin from a normalized ``Listing``.

    Prefers ``lat,lng`` (precise, no in-line geocoding) and falls back to
    ``"{building}, {address}, Hong Kong"`` when the source doesn't expose
    coordinates (Centanet today).
    """
    lat = listing.get("geo_lat")
    lng = listing.get("geo_lon")
    if lat is not None and lng is not None:
        return f"{lat},{lng}"
    parts: list[str] = []
    if listing.get("building"):
        parts.append(str(listing["building"]))
    if listing.get("address"):
        parts.append(str(listing["address"]))
    if not parts:
        raise CommuteError(
            f"Listing {listing.get('source_id', '?')} from "
            f"{listing.get('source', '?')} has neither geo coords nor "
            "a usable address. Cannot compute commute origin."
        )
    parts.append("Hong Kong")
    return ", ".join(parts)


# ---------- HTTP client ----------


class _Client:
    """Lazy httpx AsyncClient for Google Maps APIs."""

    def __init__(self) -> None:
        self.base_url = os.environ.get(
            "GOOGLE_MAPS_BASE_URL", DEFAULT_BASE_URL
        ).rstrip("/")
        self.timeout = float(
            os.environ.get("GOOGLE_MAPS_TIMEOUT_S", DEFAULT_TIMEOUT_S)
        )
        self._client: httpx.AsyncClient | None = None

    async def _ensure(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url, timeout=self.timeout
            )
        return self._client

    async def get_json(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        c = await self._ensure()
        try:
            r = await c.get(path, params=params)
        except (httpx.TimeoutException, httpx.NetworkError) as e:
            raise CommuteError(f"{path}: {type(e).__name__}: {e}") from e
        if r.status_code != 200:
            raise CommuteError(
                f"{path}: HTTP {r.status_code}: {r.text[:300]}"
            )
        data = r.json()
        # Google returns 200 even on logical errors; status sits in body.
        status = data.get("status", "")
        if status not in ("OK", "ZERO_RESULTS"):
            msg = data.get("error_message", "")
            raise CommuteError(f"{path}: Google {status}: {msg}")
        return data


_client = _Client()


# ---------- Directions API ----------


async def directions_transit(
    origin: str,
    destination: str,
    departure_time: str | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    """Fetch a TRANSIT route (Google Maps Directions API).

    Returns the raw API response — use :func:`summarize_directions` to flatten
    it into a :class:`CommuteResult`.
    """
    key = api_key or _load_api_key()
    params = {
        "origin": origin,
        "destination": destination,
        "mode": "transit",
        "departure_time": _parse_departure(departure_time),
        "key": key,
        "language": "zh-HK",
        "region": "hk",
    }
    return await _client.get_json("/directions/json", params)


def summarize_directions(raw: dict[str, Any]) -> CommuteResult:
    """Normalize a Google Directions response → flat ``CommuteResult``.

    Picks the best (first) route, splits steps by travel mode, computes
    aggregates (total / walking / transit minutes, transfer count), and
    extracts fare if denominated in HKD.
    """
    if raw.get("status") == "ZERO_RESULTS":
        raise CommuteError(
            "Google Directions returned no transit routes. "
            "Check the origin address resolves to HK and the destination is reachable."
        )
    routes = raw.get("routes") or []
    if not routes:
        raise CommuteError("Google Directions: empty routes list")
    route = routes[0]
    legs = route.get("legs") or []
    if not legs:
        raise CommuteError("Google Directions: route has no legs")
    leg = legs[0]

    total_s = (leg.get("duration") or {}).get("value", 0)

    walking_s = 0
    transit_s = 0
    transit_segments = 0
    steps_out: list[dict[str, Any]] = []
    for s in leg.get("steps") or []:
        mode = s.get("travel_mode", "")
        dur_s = (s.get("duration") or {}).get("value", 0)
        item: dict[str, Any] = {
            "mode": mode,
            "duration_min": round(dur_s / 60),
            "instructions": s.get("html_instructions", ""),
        }
        if mode == "WALKING":
            walking_s += dur_s
        elif mode == "TRANSIT":
            transit_s += dur_s
            transit_segments += 1
            td = s.get("transit_details") or {}
            line = td.get("line") or {}
            vehicle = (line.get("vehicle") or {}).get("type", "")
            item["line"] = line.get("short_name") or line.get("name", "")
            item["vehicle"] = vehicle
            item["from"] = (td.get("departure_stop") or {}).get("name", "")
            item["to"] = (td.get("arrival_stop") or {}).get("name", "")
            item["num_stops"] = td.get("num_stops")
        steps_out.append(item)

    # transfers = number of times the rider switches vehicles
    transfers = max(0, transit_segments - 1)

    fare_obj = route.get("fare") or {}
    fare_value = fare_obj.get("value")
    fare_currency = fare_obj.get("currency", "")
    fare_hkd: float | None = None
    if fare_currency == "HKD" and fare_value is not None:
        fare_hkd = float(fare_value)

    dep = leg.get("departure_time") or {}
    arr = leg.get("arrival_time") or {}
    start_loc = leg.get("start_location") or {}
    end_loc = leg.get("end_location") or {}

    result: CommuteResult = {
        "origin": {
            "lat": start_loc.get("lat"),
            "lng": start_loc.get("lng"),
            "address": leg.get("start_address", ""),
        },
        "destination": {
            "lat": end_loc.get("lat"),
            "lng": end_loc.get("lng"),
            "address": leg.get("end_address", ""),
        },
        "total_minutes": round(total_s / 60),
        "walking_minutes": round(walking_s / 60),
        "transit_minutes": round(transit_s / 60),
        "transfers": transfers,
        "steps": steps_out,
        "fare_hkd": fare_hkd,
        "fare_currency": fare_currency,
        "departure_time": dep.get("text", ""),
        "arrival_time": arr.get("text", ""),
    }
    return result
