"""28Hse data source — implements the :class:`Source` protocol.

Knowledge required of this module: 28Hse URL shape, HTML quirks, JSON-LD
schema. Nothing outside ``sources/twentyeighthse.py`` knows any of this.

URL shape::

    /en/rent[/{type}][/{region}/{district}][/page-N]?rent_from=&rent_to=&room=&size_from=&size_to=

Detail page::

    /en/rent/{type}/property-{id}

All four shape elements are independent — passing ``district_code=None``
yields all of HK; passing ``building_type="any"`` yields all property
types; passing ``page=1`` omits the page segment.
"""

from __future__ import annotations

import re
from typing import Any

from .. import districts as d_mod
from .. import parser
from ..client import client
from ..models import AgentContact, Listing, SearchResult


name = "28hse"
display_name = "28Hse 香港屋網"


# friendly name → 28Hse URL path segment
_TYPE_TO_URL_SEG: dict[str, str] = {
    "apartment": "apartment",
    "village": "village",
    "serviced": "service-apartment",
    "office": "office",
    "shop": "shop",
    "industrial": "industrial",
    "carpark": "carpark",
    "any": "",
}


def _build_search_url(
    district_code: str | None,
    building_type: str = "apartment",
    page: int = 1,
) -> str:
    """Build a 28Hse rent search URL.

    Any of ``district_code`` / ``building_type=="any"`` / ``page==1`` is
    optional and that segment is omitted.
    """
    parts = [f"/{client.lang}/rent"]

    type_seg = _TYPE_TO_URL_SEG.get(building_type, "apartment")
    if type_seg:
        parts.append(f"/{type_seg}")

    if district_code is not None:
        if district_code not in d_mod.DISTRICTS:
            raise ValueError(
                f"Unknown district code {district_code!r}; "
                f"call list_districts to discover codes"
            )
        region = d_mod.DISTRICTS[district_code][0]
        parts.append(f"/{region}/{district_code}")

    if page > 1:
        parts.append(f"/page-{page}")

    return "".join(parts)


def _build_query_params(
    min_price: int | None,
    max_price: int | None,
    min_rooms: int | None,
    min_size: int | None,
    max_size: int | None,
) -> dict[str, Any]:
    params: dict[str, Any] = {}
    if min_price is not None:
        params["rent_from"] = int(min_price)
    if max_price is not None:
        params["rent_to"] = int(max_price)
    if min_rooms is not None:
        params["room"] = int(min_rooms)
    if min_size is not None:
        params["size_from"] = int(min_size)
    if max_size is not None:
        params["size_to"] = int(max_size)
    return params


def _qs(params: dict[str, Any]) -> str:
    return "&".join(f"{k}={v}" for k, v in params.items())


def _normalize_listing(raw: dict[str, Any], from_detail: bool = False) -> Listing:
    """Map 28Hse parser output → normalized ``Listing`` dict.

    ``raw`` is whatever ``parser.parse_search_results`` or
    ``parser.parse_listing_detail`` returned. Source-specific fields go
    into ``source_extras``.
    """
    district_name = raw.get("district") or ""
    district_code = ""
    district_name_en = district_name
    district_name_zh = ""
    region_code = ""
    found = d_mod.find_district(district_name) if district_name else None
    if found:
        district_code, district_name_en, district_name_zh = found
        region_code = d_mod.DISTRICTS[district_code][0]

    pid = raw.get("property_id")
    source_id = str(pid) if pid is not None else ""

    listing: Listing = {
        "source": name,
        "source_id": source_id,
        "url": raw.get("url", ""),
        "title": raw.get("title", ""),
        "description": raw.get("description", ""),
        "price_hkd": raw.get("price_hkd"),
        "currency": raw.get("currency", "HKD"),
        "district_code": district_code,
        "district_name_en": district_name_en,
        "district_name_zh": district_name_zh,
        "region_code": region_code,
        "building": raw.get("building", ""),
        "address": raw.get("address", ""),
        "geo_lat": raw.get("geo_lat"),
        "geo_lon": raw.get("geo_lon"),
        "saleable_ft": raw.get("saleable_ft"),
        "gross_ft": raw.get("gross_ft"),
        "bedrooms": raw.get("bedrooms"),
        "bathrooms": raw.get("bathrooms"),
        "floor": raw.get("floor", ""),
        "furnished": raw.get("furnished", ""),
        "photo_count": raw.get("photo_count"),
        "image_urls": raw.get("image_urls", []),
        "agent_company": raw.get("agent_company", ""),
        "agent_company_address": raw.get("agent_company_address", ""),
        "agent_company_url": raw.get("agent_company_url", ""),
        "agent_personal": raw.get("agent_personal", ""),
        "agent_license_personal": raw.get("agent_license_personal", ""),
        "agent_license_company": raw.get("agent_license_company", ""),
        "date_published": raw.get("date_published", ""),
        "date_modified": raw.get("date_modified", ""),
    }
    # Nearest MTR (only present in detail HTML — search cards don't include it).
    mtr_station = raw.get("nearest_mtr_station") or ""
    if mtr_station:
        listing["nearest_mtr_station"] = mtr_station
    walk_min = raw.get("walk_to_mtr_minutes")
    if isinstance(walk_min, int):
        listing["walk_to_mtr_minutes"] = walk_min
    # Stash any 28Hse-only fields here.
    extras: dict[str, object] = {}
    for k in ("grade", "posted_text", "unit_desc", "property_type", "image"):
        v = raw.get(k)
        if v:
            extras[k] = v
    # Full transport items (bus stops, malls, MTR) — useful when no MTR but
    # caller wants to know what's nearby.
    ti = raw.get("transport_items")
    if ti:
        extras["transport_items"] = ti
    if extras:
        listing["source_extras"] = extras
    return listing


# ---------- Source protocol implementation ----------


async def search(
    district_code: str | None = None,
    building_type: str = "apartment",
    min_price: int | None = None,
    max_price: int | None = None,
    min_rooms: int | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    page: int = 1,
) -> SearchResult:
    url = _build_search_url(district_code, building_type, page)
    params = _build_query_params(min_price, max_price, min_rooms, min_size, max_size)

    html = await client.fetch(url, params=params)
    parsed = parser.parse_search_results(html)
    normalized = [_normalize_listing(r) for r in parsed["results"]]

    district_en = ""
    district_zh = ""
    if district_code and district_code in d_mod.DISTRICTS:
        district_en = d_mod.DISTRICTS[district_code][1]
        district_zh = d_mod.DISTRICTS[district_code][2]

    full_url = client.base_url + url
    if params:
        full_url += f"?{_qs(params)}"

    return {
        "source": name,
        "url": full_url,
        "district_code": district_code,
        "district_name_en": district_en,
        "district_name_zh": district_zh,
        "page": page,
        "total": parsed["total"],
        "results": normalized,
    }


async def get_detail(source_id: str) -> Listing:
    pid = str(source_id).strip()
    if pid.startswith("http"):
        # Full URL → take everything after the host
        path = "/" + pid.split("://", 1)[-1].split("/", 1)[-1]
    elif pid.isdigit():
        path = f"/{client.lang}/rent/apartment/property-{pid}"
    else:
        raise ValueError(f"Invalid source_id {source_id!r}")

    html = await client.fetch(path)
    raw = parser.parse_listing_detail(html)
    return _normalize_listing(raw, from_detail=True)


async def agent_contact(source_id: str) -> AgentContact:
    listing = await get_detail(source_id)
    return {
        "source": name,
        "source_id": listing.get("source_id", ""),
        "property_id": listing.get("source_id", ""),  # alias for backward compat
        "title": listing.get("title", ""),
        "building": listing.get("building", ""),
        "district": listing.get("district_name_en", ""),
        "url": listing.get("url", ""),
        "agent_personal": listing.get("agent_personal", ""),
        "agent_company": listing.get("agent_company", ""),
        "agent_company_address": listing.get("agent_company_address", ""),
        "agent_company_url": listing.get("agent_company_url", ""),
        "agent_license_personal": listing.get("agent_license_personal", ""),
        "agent_license_company": listing.get("agent_license_company", ""),
        "pdpo_warning": (
            "This contact info is published on 28Hse by the agent for this "
            "specific listing. It is public registry data under HK's Estate "
            "Agents Ordinance. Use it ONLY to enquire about this property. "
            "Do not redistribute, scrape in bulk, or use for marketing — "
            "that would violate PDPO."
        ),
    }
