"""Source-agnostic data shapes for hkprop-mcp.

Every Source implementation (28Hse today, Centanet / Spacious tomorrow)
returns these normalized dicts. The MCP tools layer never sees raw HTML or
source-specific JSON — only these.

Why ``TypedDict`` and not ``@dataclass``: TypedDicts cross the MCP JSON
boundary cleanly (no ``.to_dict()`` rituals), and we want ``total=False`` so
sources can omit fields they can't recover.
"""

from __future__ import annotations

from typing import TypedDict


class Listing(TypedDict, total=False):
    """A single property listing, normalized across sources.

    ``source`` + ``source_id`` together form a stable identity. Use the full
    ``url`` for navigation and ``geo_lat`` / ``geo_lon`` for mapping.
    """

    # ---- Identity ----
    source: str               # e.g. "28hse", "centanet", "spacious"
    source_id: str            # platform-specific ID as a string (e.g. "3860784")
    url: str                  # canonical detail URL

    # ---- Title / description ----
    title: str
    description: str

    # ---- Pricing ----
    price_hkd: int | None     # monthly rent in HKD
    currency: str             # always "HKD" for now

    # ---- Location ----
    district_code: str        # our internal code, e.g. "dg48"
    district_name_en: str
    district_name_zh: str
    region_code: str          # "a1" / "a2" / "a3" / "a4"
    building: str             # estate or building name
    address: str              # full street address
    geo_lat: float | None
    geo_lon: float | None

    # ---- Physical attributes ----
    saleable_ft: int | None
    gross_ft: int | None
    bedrooms: int | None      # 0 = studio
    bathrooms: int | None
    floor: str                # free-text floor description ("Mid Floor 15-25, 29/F")
    furnished: str            # free-text status ("Partially Furnished", etc.)

    # ---- Media ----
    photo_count: int | None
    image_urls: list[str]

    # ---- Transit (populated where the source exposes it; else absent) ----
    nearest_mtr_station: str         # e.g. "兆康" / "Tuen Mun"
    walk_to_mtr_minutes: int | None  # walking time from listing to that station

    # ---- Agent ----
    agent_company: str
    agent_company_address: str
    agent_company_url: str
    agent_personal: str
    agent_license_personal: str   # e.g. "S-706133" (HK Estate Agents Authority)
    agent_license_company: str    # e.g. "C-000982"

    # ---- Dates ----
    date_published: str       # ISO-8601 string
    date_modified: str

    # ---- Source-specific extras ----
    # Sources may add their own fields under ``source_extras`` rather than
    # polluting the top level. Tools layer should not depend on these.
    source_extras: dict[str, object]


class SearchResult(TypedDict):
    """Paginated search result envelope."""

    source: str
    url: str                  # the actual URL that was fetched
    district_code: str | None
    district_name_en: str
    district_name_zh: str
    page: int
    total: int | None         # total matching listings across all pages
    results: list[Listing]


class AgentContact(TypedDict, total=False):
    """Agent contact info for a single listing, with PDPO warning."""

    source: str
    source_id: str
    property_id: str
    title: str
    building: str
    district: str
    url: str

    agent_personal: str
    agent_company: str
    agent_company_address: str
    agent_company_url: str
    agent_license_personal: str
    agent_license_company: str

    pdpo_warning: str
