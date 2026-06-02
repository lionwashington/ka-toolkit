"""Source-agnostic dispatcher for the 4 MCP tools.

This module knows nothing about 28Hse-specific URLs or HTML. It resolves a
``source`` argument to the right module under :mod:`hkprop_mcp.sources` and
forwards the call. Each source returns normalized :mod:`models` types, so
the server layer can format them uniformly.
"""

from __future__ import annotations

import asyncio
from typing import Any

from . import commute as commute_mod
from . import districts as d_mod
from . import sources
from .models import AgentContact, Listing, SearchResult


def _resolve_district(district: str | None) -> str | None:
    """Return a district code, or None to mean 'all HK'.

    Accepts either a code (``dg48``) or a name in EN/ZH (``Tuen Mun`` / ``屯門``).
    """
    if district is None or not str(district).strip():
        return None
    s = str(district).strip()
    if s in d_mod.DISTRICTS:
        return s
    found = d_mod.find_district(s)
    if found is None:
        raise ValueError(
            f"District {district!r} not recognized. "
            f"Call list_districts to see available codes/names."
        )
    return found[0]


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
    source: str = sources.DEFAULT_SOURCE,
) -> SearchResult:
    """Search rental listings on the given source(s).

    ``district`` may be a code (``dg48``), an EN/ZH name (``Tuen Mun`` / ``屯門``),
    or ``None`` for HK-wide results.

    ``source`` may be:
      - a specific source name (``"28hse"`` / ``"centanet"``), or
      - ``"all"`` to fan-out across every registered source in parallel and
        return a merged, de-duplicated result.
    """
    district_code = _resolve_district(district)

    if source == sources.ALL_SOURCES:
        result = await _aggregate_search(
            district_code, building_type, min_price, max_price, min_rooms,
            min_size, max_size, page,
        )
    else:
        impl = sources.get(source)
        result = await impl.search(
            district_code=district_code,
            building_type=building_type,
            min_price=min_price,
            max_price=max_price,
            min_rooms=min_rooms,
            min_size=min_size,
            max_size=max_size,
            page=page,
        )

    # Furnished filter hint (no source supports it in-query).
    if furnished and result.get("results"):
        for r in result["results"]:
            extras = r.setdefault("source_extras", {})  # type: ignore[typeddict-item]
            extras["furnished_filter_note"] = (  # type: ignore[index]
                f"Filter furnished={furnished!r} cannot be applied from search "
                f"results alone. Call get_listing_detail to verify each."
            )
    return result


async def _aggregate_search(
    district_code: str | None,
    building_type: str,
    min_price: int | None,
    max_price: int | None,
    min_rooms: int | None,
    min_size: int | None,
    max_size: int | None,
    page: int,
) -> SearchResult:
    """Run search across every registered source concurrently and merge."""
    impls = sources.all_sources()
    coros = [
        impl.search(
            district_code=district_code,
            building_type=building_type,
            min_price=min_price,
            max_price=max_price,
            min_rooms=min_rooms,
            min_size=min_size,
            max_size=max_size,
            page=page,
        )
        for impl in impls
    ]
    settled = await asyncio.gather(*coros, return_exceptions=True)

    merged: list[Listing] = []
    total = 0
    sources_used: list[str] = []
    errors: list[str] = []
    for impl, r in zip(impls, settled):
        if isinstance(r, Exception):
            errors.append(f"{impl.name}: {type(r).__name__}: {r}")
            continue
        sources_used.append(impl.name)
        if r.get("total") is not None:
            total += r["total"]
        merged.extend(r.get("results") or [])

    deduped = _dedupe_listings(merged)

    district_en = ""
    district_zh = ""
    if district_code and district_code in d_mod.DISTRICTS:
        district_en = d_mod.DISTRICTS[district_code][1]
        district_zh = d_mod.DISTRICTS[district_code][2]

    result: SearchResult = {
        "source": "+".join(sources_used) if sources_used else "all",
        "url": "(aggregate across all registered sources)",
        "district_code": district_code,
        "district_name_en": district_en,
        "district_name_zh": district_zh,
        "page": page,
        "total": total if total else None,
        "results": deduped,
    }
    if errors:
        # Surface errors per-source without failing the whole query.
        result.setdefault("results", [])  # type: ignore[misc]
        # Stash in a fake first result for visibility? No — log instead.
        # Append a synthetic error entry the LLM can read.
        result["results"].insert(0, {  # type: ignore[arg-type]
            "source": "_errors",
            "source_id": "",
            "url": "",
            "title": "(some sources errored; results may be incomplete)",
            "description": "\n".join(errors),
        })
    return result


def _dedupe_listings(listings: list[Listing]) -> list[Listing]:
    """Merge listings that appear in multiple sources for the same property.

    Heuristic: same building + address + price → same property. The richer
    record wins (more non-empty fields). The other record's source is noted
    in ``source_extras.also_listed_on``.
    """
    by_key: dict[tuple[str, str, int], Listing] = {}
    for l in listings:
        key = (
            (l.get("building") or "").strip().lower(),
            (l.get("address") or "").strip().lower(),
            int(l.get("price_hkd") or 0),
        )
        # Skip dedup if all key components empty.
        if key == ("", "", 0):
            by_key[(l.get("source", ""), l.get("source_id", ""), 0)] = l
            continue
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = l
            continue
        # Merge: keep the richer one (more non-empty fields), annotate.
        if _richness(l) > _richness(existing):
            preferred, other = l, existing
        else:
            preferred, other = existing, l
        extras = preferred.setdefault("source_extras", {})  # type: ignore[typeddict-item]
        also: list[str] = extras.get("also_listed_on", []) if isinstance(extras, dict) else []
        if isinstance(also, list):
            other_src = other.get("source", "")
            if other_src and other_src not in also:
                also.append(other_src)
            extras["also_listed_on"] = also
        by_key[key] = preferred
    return list(by_key.values())


def _richness(listing: Listing) -> int:
    """Count non-empty fields — used to pick the richer of duplicate listings."""
    score = 0
    for k, v in listing.items():
        if v in (None, "", 0, [], {}):
            continue
        score += 1
    return score


async def get_listing_detail(
    property_id: int | str | dict[str, Any],
    source: str = sources.DEFAULT_SOURCE,
) -> Listing:
    """Fetch full normalized detail for one listing.

    ``property_id`` accepts either:
      - ``int`` / ``str`` — a source-specific listing id. For 28Hse this is
        the numeric property id (e.g. ``"3860784"``). For Centanet, prefer
        the refNo (``"CGB284"``) — the UUID form works too but triggers a
        slower multi-page Search scan.
      - ``dict`` — a Listing already obtained from a prior ``search_listings``
        call. The dispatcher reads ``source`` from the dict (overriding the
        ``source`` kwarg) and prefers ``source_extras.refNo`` over
        ``source_id`` when calling Centanet (avoids the UUID-lookup penalty).
    """
    if isinstance(property_id, dict):
        listing = property_id
        src_from_dict = (listing.get("source") or "").strip()
        if src_from_dict:
            source = src_from_dict
        sid = str(listing.get("source_id") or "").strip()
        if source == "centanet":
            extras = listing.get("source_extras") or {}
            ref = ""
            if isinstance(extras, dict):
                ref = str(extras.get("refNo") or "").strip()
            if ref:
                sid = ref
        if not sid:
            raise ValueError(
                "Listing dict has no usable identifier (no source_id, and no "
                "refNo in source_extras for Centanet). Re-fetch via "
                "search_listings or pass the id directly."
            )
        impl = sources.get(source)
        return await impl.get_detail(sid)

    impl = sources.get(source)
    return await impl.get_detail(str(property_id))


async def agent_contact(
    property_id: int | str,
    source: str = sources.DEFAULT_SOURCE,
) -> AgentContact:
    """Return the agent's contact info + PDPO warning for one listing."""
    impl = sources.get(source)
    return await impl.agent_contact(str(property_id))


async def commute_to_school(
    property_id: int | str | dict[str, Any],
    source: str = sources.DEFAULT_SOURCE,
    school: str = commute_mod.DEFAULT_DESTINATION,
    departure_time: str | None = None,
) -> dict[str, Any]:
    """Compute transit commute time from a listing to a school.

    ``property_id`` accepts either:
      - ``int`` / ``str`` — a source-specific listing id. The matching source
        is asked for ``get_detail(id)`` to fetch the location. Cheap on 28Hse
        (direct URL), but on Centanet the public API has no per-id endpoint
        and only the first 50 unfiltered Search results are reachable — so
        less-popular Centanet listings raise ``CentanetFetchError``.
      - ``dict`` — a Listing already obtained from a prior ``search_listings``
        call. The lookup step is skipped entirely (saves one request and
        sidesteps the Centanet 50-result ceiling). Pass the dict you already
        have; the dispatcher reads ``building`` / ``address`` / ``geo_*`` for
        the Directions origin.

    After resolving the origin (lat/lng if available, else building+address
    string for in-line geocoding) it calls Google Maps Directions in transit
    mode and returns a flattened ``CommuteResult`` annotated with the listing.
    """
    if isinstance(property_id, dict):
        listing: Listing = property_id  # type: ignore[assignment]
    else:
        impl = sources.get(source)
        listing = await impl.get_detail(str(property_id))
    origin = commute_mod.origin_from_listing(listing)
    raw = await commute_mod.directions_transit(
        origin=origin,
        destination=school,
        departure_time=departure_time,
    )
    result = commute_mod.summarize_directions(raw)
    # Annotate with listing identity so the caller knows what was matched.
    result["listing"] = {
        "source": listing.get("source", ""),
        "source_id": listing.get("source_id", ""),
        "building": listing.get("building", ""),
        "address": listing.get("address", ""),
        "url": listing.get("url", ""),
        "price_hkd": listing.get("price_hkd"),
    }
    return result


async def list_districts() -> dict[str, Any]:
    """Return the HK district / region / property-type lookup tables + sources."""
    return {
        "districts": d_mod.list_all(),
        "regions": [
            {"code": code, "name_en": en, "name_zh": zh}
            for code, (en, zh) in d_mod.REGIONS.items()
        ],
        "property_types": [
            {"key": k, "name_en": en, "name_zh": zh}
            for k, (en, zh) in d_mod.PROPERTY_TYPES.items()
        ],
        "sources": sources.list_sources(),
        "default_source": sources.DEFAULT_SOURCE,
        "note": (
            "Use `code` (e.g. 'dg48') as the `district` arg in search_listings, "
            "or pass an EN/ZH name and it will be resolved. Omit `district` "
            "entirely (or pass None) to search HK-wide."
        ),
    }
