"""hkprop-mcp — Hong Kong rental search MCP server (stdio).

Tools:
  - search_listings(district?, building_type, min_price?, max_price?,
                    min_rooms?, min_size?, max_size?, furnished?, page,
                    source)
  - get_listing_detail(property_id, source)
  - list_districts()
  - agent_contact(property_id, source)   ← carries a PDPO warning

V1 source: 28hse. Architecture supports adding Centanet, Spacious, etc.
without changing the tool schemas — pass a different ``source`` value.
"""

from __future__ import annotations

import json
import logging
import sys

from mcp.server.fastmcp import FastMCP

from . import commute
from . import sources
from . import tools as t
from .client import FetchError

logger = logging.getLogger("hkprop_mcp")

mcp = FastMCP("hkprop")


def _fmt(obj: object) -> str:
    return json.dumps(obj, indent=2, default=str, ensure_ascii=False)


def _err(e: Exception) -> str:
    return f"Error: {type(e).__name__}: {e}"


@mcp.tool()
async def search_listings(
    district: str | None = None,
    building_type: str = "apartment",
    min_price: int | None = None,
    max_price: int | None = None,
    min_rooms: int | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    furnished: str | None = None,
    page: int = 1,
    source: str = "28hse",
) -> str:
    """Search Hong Kong rental listings.

    Args:
        district: District code (``"dg48"``) or name in EN/ZH (``"Tuen Mun"`` / ``"屯門"``).
                  **Omit (or pass null) to search HK-wide** — useful when you want
                  to see what's available across all districts in your price range.
                  Call ``list_districts`` to see all 62 codes.
        building_type: One of: ``apartment``, ``village``, ``serviced``, ``office``,
                       ``shop``, ``industrial``, ``carpark``, or ``any`` (all types).
                       Default ``apartment``.
        min_price: Min monthly rent in HKD (e.g. ``10000``).
        max_price: Max monthly rent in HKD (e.g. ``15000``).
        min_rooms: Min bedroom count (use 0 for studio).
        min_size: Min saleable area in sqft (e.g. ``300``).
        max_size: Max saleable area in sqft.
        furnished: Filter hint (no direct URL param; use ``get_listing_detail``
                   to verify furnishing accurately per listing).
        page: 1-indexed page number. ~15 results per page.
        source: Data source. Supports ``"28hse"`` (HTML scrape) and ``"centanet"``
                (中原地產, REST API direct). Pass ``"all"`` to fan-out across every
                registered source in parallel and merge results (de-duped by
                building+address+price). Call ``list_districts`` to see options.

    Returns:
        JSON with ``source``, ``url``, ``district_code``, ``page``, ``total``,
        and ``results`` (a list of normalized ``Listing`` dicts).
    """
    try:
        return _fmt(await t.search_listings(
            district=district,
            building_type=building_type,
            min_price=min_price,
            max_price=max_price,
            min_rooms=min_rooms,
            min_size=min_size,
            max_size=max_size,
            furnished=furnished,
            page=page,
            source=source,
        ))
    except FetchError as e:
        return f"FETCH_ERROR: {e}"
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
async def get_listing_detail(
    property_id: str | dict,
    source: str = "28hse",
) -> str:
    """Fetch full normalized detail for one listing.

    Args:
        property_id: One of:
          - 28Hse numeric id (e.g. ``"3860784"``) or detail URL.
          - **Centanet refNo** (e.g. ``"CGB284"``) — preferred, single API call.
          - Centanet detail URL (refNo is extracted automatically).
          - Centanet UUID — works but slower (scans up to 5 search pages).
          - **Listing dict** — a Listing already returned by
            ``search_listings``. The dispatcher reads ``source`` from the
            dict and prefers the embedded refNo over the UUID, avoiding the
            lookup penalty. Pass this whenever you have it.
        source: Data source. Default ``"28hse"``. Ignored when
                ``property_id`` is a dict (the dict's own ``source`` wins).

    Returns:
        JSON ``Listing`` with title, address, price, area, beds/baths, floor,
        furnished, agent, license, geo (lat/lon), dates, and image URLs.
        Centanet detail additionally fills ``nearest_mtr_station`` /
        ``walk_to_mtr_minutes`` (top-level, cross-source) and
        ``source_extras`` with ``feature_tags`` / ``school_net_primary`` /
        ``cat_label_description`` / ``management_company`` /
        ``mtr_walk_minutes_all`` / ``managementInclu`` /
        ``govRateInclu`` / ``govRentInclu``.
        **Note**: Centanet has no structured ``furnished`` field — use
        ``image_urls`` (6-8 photos) and ``feature_tags`` to judge furnishing.
    """
    try:
        return _fmt(await t.get_listing_detail(property_id, source=source))
    except FetchError as e:
        return f"FETCH_ERROR: {e}"
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
async def list_districts() -> str:
    """List all HK district codes, region codes, property types, and registered sources.

    Use the ``code`` field as the ``district`` arg of ``search_listings`` (or
    pass a name — it'll be resolved). ``sources`` lists data backends supported.
    """
    try:
        return _fmt(await t.list_districts())
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
async def agent_contact(
    property_id: str,
    source: str = "28hse",
) -> str:
    """Get agent contact info for one listing.

    ⚠️ PDPO WARNING: This returns publicly-published contact info for the
    agent who posted the listing. Use ONLY to enquire about this specific
    property. DO NOT redistribute, bulk-collect, or use for marketing —
    that would violate Hong Kong's Personal Data Privacy Ordinance.

    Args:
        property_id: Numeric listing ID.
        source: Data source. Default ``"28hse"``.

    Returns:
        JSON with ``agent_personal`` (name), ``agent_company``,
        ``agent_company_address``, license numbers (HK Estate Agents Authority
        ``S-XXXXXX`` and ``C-XXXXXX``), and a PDPO warning. Phone numbers
        are gated behind 28Hse's contact form and not exposed here.
    """
    try:
        return _fmt(await t.agent_contact(property_id, source=source))
    except FetchError as e:
        return f"FETCH_ERROR: {e}"
    except Exception as e:  # noqa: BLE001
        return _err(e)


@mcp.tool()
async def commute_to_school(
    property_id: str | dict,
    source: str = "28hse",
    school: str = commute.DEFAULT_DESTINATION,
    departure_time: str | None = None,
) -> str:
    """Compute transit commute (public transport + walking) from a listing to a school.

    Pulls the listing's location, then asks Google Maps Directions API for
    a transit route to the destination. Designed for evaluating HK rental
    candidates against the user's daily school commute.

    Args:
        property_id: Either:
            - Listing ID (string) — e.g. ``"3860784"`` (28hse) or a Centanet
              UUID. The matching source is asked to ``get_detail(id)`` first.
              ⚠️ Centanet has no per-id endpoint; only the first 50 unfiltered
              Search results are reachable by id alone. If you got the listing
              from a narrow search (district / price / rooms / size filters),
              prefer the dict form below.
            - **Listing dict** — the full listing object you already received
              from a prior ``search_listings`` call. Lookup is skipped
              entirely (saves a request and sidesteps the Centanet 50-result
              ceiling). Recommended whenever you have the listing in hand.
        source: ``"28hse"`` or ``"centanet"``. Default ``"28hse"``.
                Ignored when ``property_id`` is a dict (the dict's own
                ``source`` field wins).
        school: Destination, free-text address or place name. Default is
                Victoria Harbour, Hong Kong (a neutral default; pass your own).
                Google handles geocoding — pass the full HK address if the
                school name alone is ambiguous.
        departure_time: ``"now"``, ISO 8601 (``"2026-06-01T08:00:00+08:00"``),
                        or omit for next weekday 08:00 HKT (realistic school
                        commute window — schedules + crowds reflect reality).

    Returns:
        JSON with ``total_minutes``, ``walking_minutes``, ``transit_minutes``,
        ``transfers``, ``steps`` (step-by-step instructions), ``fare_hkd``,
        ``departure_time``, ``arrival_time``, plus ``origin`` and
        ``destination`` (lat/lng + resolved address) and ``listing`` (the
        source listing being evaluated).

    Requires ``google_maps_api_key`` in ``~/.knowledge-assistant/secrets.yaml``
    or ``GOOGLE_MAPS_API_KEY`` env var.
    """
    try:
        return _fmt(await t.commute_to_school(
            property_id=property_id,
            source=source,
            school=school,
            departure_time=departure_time,
        ))
    except FetchError as e:
        return f"FETCH_ERROR: {e}"
    except commute.CommuteError as e:
        return f"COMMUTE_ERROR: {e}"
    except Exception as e:  # noqa: BLE001
        return _err(e)


def main() -> None:
    logging.basicConfig(
        level=logging.WARNING,
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    mcp.run()
