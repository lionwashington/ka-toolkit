"""Centanet (中原地產) data source — implements the :class:`Source` protocol.

Unlike 28Hse (which is HTML-only), Centanet exposes a clean REST API at
``https://hk-api.centanet.com/centanetapi``. We hit it directly — no HTML
parsing, no DOM scraping.

Discovered via Nuxt JS bundle analysis (``/findproperty/_nuxt/*.js``).
The API was designed for Centanet's own SPA frontend; we use it the same way
the frontend does, with a real-browser User-Agent.

Two endpoints in use:

  - ``POST /api/Post/Search`` — list / search rental listings (paginated).
  - ``GET  /api/Post/Detail?refNo=...&fromPostType=Rent&displayTextStyle=WebDetail``
    — single-listing detail. Returns the **same record shape** as Search
    items plus media.postImages (6-8 photos), labelGroup.nearbyFacilities
    (MTR + walk minutes), feature.topics (tags), estateInfo (school net,
    management company), postAgents (license + WhatsApp), and gMap (precise
    lat/lng — Search returns none).

Search request params (from JS bundle + live probe):

  - ``postType``: ``"Rent"`` / ``"Sale"`` / ``"Both"``
  - ``amountRange``: ``{"min": int, "max": int}`` (HKD; for rent, monthly)
  - ``nSizeRange``: ``{"min": int, "max": int}`` (saleable sqft)
  - ``page``: 1-indexed
  - ``size``: results per page (default 24, max ~50)
  - ``sort``: ``"Ranking"`` / etc.
  - ``order``: ``"Ascending"`` / ``"Descending"``

District + bedroom filters are applied **client-side** (post-fetch).
Server-side ``typeCodes`` exists but takes building-specific codes
(e.g. ``"1-NLIITHIETN"``), not district codes — too granular for our UX.
We filter by ``scope.webScope`` text match instead.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

import httpx

from .. import districts as d_mod
from ..models import AgentContact, Listing, SearchResult

logger = logging.getLogger(__name__)


name = "centanet"
display_name = "Centanet 中原地產"

DEFAULT_BASE_URL = "https://hk-api.centanet.com/centanetapi"
WEB_BASE_URL = "https://hk.centanet.com"  # for Referer + detail URLs
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Safari/605.1.15 "
    "hkprop-mcp/0.1 (personal-use)"
)
DEFAULT_PAGE_SIZE = 24
MAX_PAGE_SIZE = 50

# building_type (our names) → Centanet postType
_POSTTYPE_BY_BUILDING_TYPE: dict[str, str] = {
    "apartment": "Rent",  # Centanet doesn't sub-segment by apartment vs other
    "village": "Rent",
    "serviced": "Rent",
    "office": "Rent",
    "shop": "Rent",
    "industrial": "Rent",
    "carpark": "Rent",
    "any": "Rent",
    # "sale" / "both" reserved for future sale-mode tools
}


class _Client:
    """Lazy httpx AsyncClient with rate limit + Referer."""

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._lock_initialized = False
        import asyncio as _aio
        self._lock = _aio.Lock()
        self._last_request_time = 0.0
        self.base_url = os.environ.get("CENTANET_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
        self.user_agent = os.environ.get("CENTANET_USER_AGENT", DEFAULT_USER_AGENT)
        self.min_interval = float(os.environ.get("CENTANET_MIN_REQUEST_INTERVAL_S", "1.0"))
        self.timeout = float(os.environ.get("CENTANET_TIMEOUT_S", "15"))

    async def _ensure(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self.timeout,
                follow_redirects=True,
                headers={
                    "User-Agent": self.user_agent,
                    "Accept": "application/json",
                    "Accept-Language": "en-US,en;q=0.9,zh-HK;q=0.8",
                    "Content-Type": "application/json",
                    "Origin": WEB_BASE_URL,
                    "Referer": f"{WEB_BASE_URL}/findproperty/list/rent",
                },
            )
        return self._client

    async def _rate_limit(self) -> None:
        import asyncio
        async with self._lock:
            now = asyncio.get_event_loop().time()
            wait = self.min_interval - (now - self._last_request_time)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_request_time = asyncio.get_event_loop().time()

    async def post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        await self._rate_limit()
        c = await self._ensure()
        try:
            r = await c.post(path, content=json.dumps(payload))
        except (httpx.TimeoutException, httpx.NetworkError) as e:
            raise CentanetFetchError(f"{path}: {type(e).__name__}: {e}") from e
        if r.status_code != 200:
            raise CentanetFetchError(f"{path}: HTTP {r.status_code}: {r.text[:200]}")
        return r.json()

    async def get_json(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        await self._rate_limit()
        c = await self._ensure()
        try:
            r = await c.get(path, params=params)
        except (httpx.TimeoutException, httpx.NetworkError) as e:
            raise CentanetFetchError(f"{path}: {type(e).__name__}: {e}") from e
        if r.status_code != 200:
            raise CentanetFetchError(f"{path}: HTTP {r.status_code}: {r.text[:200]}")
        return r.json()


class CentanetFetchError(RuntimeError):
    """Raised when a Centanet API call fails."""


_client = _Client()


# ---------- helpers ----------


def _build_payload(
    building_type: str,
    min_price: int | None,
    max_price: int | None,
    min_size: int | None,
    max_size: int | None,
    page: int,
    size: int,
) -> dict[str, Any]:
    post_type = _POSTTYPE_BY_BUILDING_TYPE.get(building_type, "Rent")
    payload: dict[str, Any] = {
        "postType": post_type,
        "page": max(1, int(page)),
        "size": max(1, min(int(size), MAX_PAGE_SIZE)),
        "sort": "Ranking",
        "order": "Descending",
    }
    if min_price is not None or max_price is not None:
        amount: dict[str, int] = {}
        if min_price is not None:
            amount["min"] = int(min_price)
        if max_price is not None:
            amount["max"] = int(max_price)
        if amount:
            payload["amountRange"] = amount
    if min_size is not None or max_size is not None:
        nsize: dict[str, int] = {}
        if min_size is not None:
            nsize["min"] = int(min_size)
        if max_size is not None:
            nsize["max"] = int(max_size)
        if nsize:
            payload["nSizeRange"] = nsize
    return payload


def _district_matches(raw_listing: dict[str, Any], district_code: str | None) -> bool:
    """Client-side district filter.

    Centanet uses combined web scopes like ``"上水 | 粉嶺 | 古洞"``. We match
    by checking whether the district's Chinese name appears anywhere in the
    listing's ``scope.webScope`` or ``scope.db``.
    """
    if district_code is None:
        return True
    if district_code not in d_mod.DISTRICTS:
        return False
    _region, _en, district_zh = d_mod.DISTRICTS[district_code]
    scope = raw_listing.get("scope") or {}
    web_scope = (scope.get("webScope") or "").strip()
    db = (scope.get("db") or "").strip()
    if district_zh in web_scope:
        return True
    if district_zh in db:
        return True
    return False


def _bedrooms_match(raw_listing: dict[str, Any], min_rooms: int | None) -> bool:
    if min_rooms is None:
        return True
    bedrooms = raw_listing.get("bedroomCount")
    if bedrooms is None:
        return True  # Don't drop unknown-bedroom listings; let agent decide
    try:
        return int(bedrooms) >= int(min_rooms)
    except (ValueError, TypeError):
        return True


def _normalize(raw: dict[str, Any]) -> Listing:
    """Centanet API record → normalized ``Listing``."""
    scope = raw.get("scope") or {}
    price_info = raw.get("priceInfo") or {}
    area_info = raw.get("areaInfo") or {}
    picture = raw.get("picture") or {}
    media = raw.get("mediaInfo") or {}

    # Resolve district by Chinese name from scope.webScope (Centanet) → our dg-code.
    web_scope_zh = (scope.get("webScope") or "").strip()
    district_code = ""
    district_name_en = web_scope_zh  # fallback to raw scope text
    district_name_zh = web_scope_zh
    region_code = ""
    found = d_mod.find_district(web_scope_zh.split(" | ")[0]) if web_scope_zh else None
    if found:
        district_code, district_name_en, district_name_zh = found
        region_code = d_mod.DISTRICTS[district_code][0]

    # Building name: combine estate + building if both present. Some listings
    # (older buildings without per-block names) only populate bigEstateName —
    # fall back to that so the field never ends up empty when ANY name exists.
    estate = (raw.get("estateName") or "").strip()
    building = (raw.get("buildingName") or "").strip()
    if estate and building:
        building_full = f"{estate} {building}"
    else:
        building_full = estate or building or (raw.get("bigEstateName") or "").strip()

    rent = price_info.get("rent")
    price_hkd = int(rent) if rent else None

    saleable_ft = area_info.get("nSize")
    gross_ft = area_info.get("size")

    image_urls: list[str] = []
    thumb = picture.get("thumbnailPath")
    if thumb:
        image_urls.append(thumb)

    listing: Listing = {
        "source": name,
        "source_id": raw.get("id", ""),
        "url": raw.get("detailUrl", ""),
        "title": f"{building_full} ({raw.get('refNo','')})".strip(" ()"),
        "description": "",  # Not in search response; fetch detail page for this
        "price_hkd": price_hkd,
        "currency": "HKD",
        "district_code": district_code,
        "district_name_en": district_name_en,
        "district_name_zh": district_name_zh,
        "region_code": region_code,
        "building": building_full,
        "address": (raw.get("address") or "").strip(),
        "geo_lat": None,  # Not in search response
        "geo_lon": None,
        "saleable_ft": int(saleable_ft) if isinstance(saleable_ft, (int, float)) else None,
        "gross_ft": int(gross_ft) if isinstance(gross_ft, (int, float)) else None,
        "bedrooms": raw.get("bedroomCount"),
        "bathrooms": None,  # Not exposed in search response
        "floor": "",  # Not in search response
        "furnished": "",  # Not exposed
        "photo_count": 1 if thumb else 0,
        "image_urls": image_urls,
        "agent_company": "",
        "agent_company_address": "",
        "agent_company_url": "",
        "agent_personal": "",
        "agent_license_personal": "",
        "agent_license_company": "",
        "date_published": raw.get("publishDate", ""),
        "date_modified": raw.get("updateDate", ""),
    }

    # Centanet-specific bonus fields
    extras: dict[str, object] = {}
    for k in ("refNo", "buildingType", "buildingAge", "direction",
              "monthlyPayment", "isDiscountPost", "typeCode"):
        v = raw.get(k)
        if v not in (None, "", 0, False):
            extras[k] = v
    # Sub-district / HMA gives a finer locality
    hma = scope.get("hma")
    if hma:
        extras["hma"] = hma
    extras["webScope_raw"] = scope.get("webScope", "")
    extras["mediaInfo"] = {
        k: v for k, v in media.items() if v and k.startswith("has")
    }
    if extras:
        listing["source_extras"] = extras
    return listing


# ---------- Source protocol ----------


async def search(
    district_code: str | None = None,
    building_type: str = "apartment",
    min_price: int | None = None,
    max_price: int | None = None,
    min_rooms: int | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    page: int = 1,
    size: int = DEFAULT_PAGE_SIZE,
) -> SearchResult:
    payload = _build_payload(
        building_type, min_price, max_price, min_size, max_size, page, size
    )
    raw_response = await _client.post_json("/api/Post/Search", payload)
    raw_listings = raw_response.get("data") or []
    total_unfiltered = raw_response.get("count", 0)

    # Server-side filtering done; now apply client-side district + bedroom.
    filtered: list[dict[str, Any]] = []
    for r in raw_listings:
        if not _district_matches(r, district_code):
            continue
        if not _bedrooms_match(r, min_rooms):
            continue
        filtered.append(r)

    normalized = [_normalize(r) for r in filtered]

    district_en = ""
    district_zh = ""
    if district_code and district_code in d_mod.DISTRICTS:
        district_en = d_mod.DISTRICTS[district_code][1]
        district_zh = d_mod.DISTRICTS[district_code][2]

    return {
        "source": name,
        "url": f"{_client.base_url}/api/Post/Search  (payload: {json.dumps(payload, ensure_ascii=False)})",
        "district_code": district_code,
        "district_name_en": district_en,
        "district_name_zh": district_zh,
        "page": page,
        "total": total_unfiltered,
        "results": normalized,
    }


# ---------- detail (per-listing) ----------


# Centanet refNos look like "CGB284" / "CPH580" — 1-4 letters then digits.
# The leading letter is "C" (Centanet) in all observed samples but we don't
# hard-code that; future B2B prefixes might differ.
_REFNO_RE = re.compile(r"^[A-Z]{1,5}\d{2,}$")
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
# Pull "CGB284" out of "https://hk.centanet.com/findproperty/detail/兆康苑_CGB284"
# (handles both raw and percent-encoded estate prefixes).
_REFNO_IN_URL_RE = re.compile(r"_([A-Z]{1,5}\d{2,})(?:[/?#]|$)")
# Search across up to MAX_DETAIL_LOOKUP_PAGES * MAX_PAGE_SIZE listings when
# resolving a UUID → refNo. 5 * 50 = 250 rentals — covers virtually every
# realistic case without DoSing the API.
MAX_DETAIL_LOOKUP_PAGES = 5


def _extract_refno(source_id: str) -> str | None:
    """Recover a Centanet refNo from various input shapes.

    Returns ``None`` if the input is not a refNo and contains no embedded one
    (e.g. a UUID — handled by the multi-page search fallback in
    :func:`get_detail`).
    """
    s = str(source_id).strip()
    if not s:
        return None
    if _REFNO_RE.match(s):
        return s
    m = _REFNO_IN_URL_RE.search(s)
    if m:
        return m.group(1)
    return None


async def _find_refno_by_uuid(uuid: str) -> str | None:
    """Multi-page search to map a Centanet UUID → refNo.

    Used only as a fallback when the caller has a UUID (e.g. taken from a
    much older search response) and the cheap refNo path is unavailable.
    """
    for page in range(1, MAX_DETAIL_LOOKUP_PAGES + 1):
        payload = {
            "postType": "Rent",
            "page": page,
            "size": MAX_PAGE_SIZE,
            "sort": "Ranking",
            "order": "Descending",
        }
        raw = await _client.post_json("/api/Post/Search", payload)
        records = raw.get("data") or []
        for r in records:
            if r.get("id") == uuid:
                ref = (r.get("refNo") or "").strip()
                if ref:
                    return ref
        if len(records) < MAX_PAGE_SIZE:
            break  # last page reached
    return None


def _normalize_detail(raw: dict[str, Any]) -> Listing:
    """``/api/Post/Detail`` record → normalized ``Listing``.

    The detail record shares its top-level schema with Search records, so we
    reuse :func:`_normalize` and then enrich with detail-only fields:

    - ``media.postImages[]`` → full ``image_urls`` list (Search only had 1 thumbnail)
    - ``gMap.lat`` / ``gMap.lng`` → ``geo_lat`` / ``geo_lon`` (Search had none —
      this unlocks precise commute origins for Centanet listings)
    - ``yAxis`` / ``xAxis`` → ``floor`` (e.g. "二樓 3室")
    - ``labelGroup.nearbyFacilities.mtrLabels[0]`` → ``nearest_mtr_station`` +
      ``walk_to_mtr_minutes`` (cross-source fields, populated only where
      the source exposes them)
    - ``postAgents[0]`` → agent name / license (Search had none)
    - ``feature.topics`` / ``estateInfo.schoolNet`` / ``catLabelDescription``
      / ``managementInclu`` / etc. → ``source_extras`` (Centanet-specific)
    - ``webUrl`` → ``url`` if not already populated

    Note: Centanet has **no structured ``furnished`` field** at any layer.
    The closest signals are ``feature.topics`` tags and the photo descriptions
    in ``media.postImages[].description`` (e.g. "客飯廳" / "廚房" hint at
    furnishing). Callers wanting furnished-only filtering must inspect
    ``image_urls`` and ``feature_tags`` manually.
    """
    listing = _normalize(raw)

    # Multi-image list (vs single thumbnail).
    media = raw.get("media") or {}
    post_images = media.get("postImages") or []
    image_urls: list[str] = []
    images_detailed: list[dict[str, Any]] = []
    for img in post_images:
        if not isinstance(img, dict):
            continue
        path = img.get("path") or ""
        if not path:
            continue
        image_urls.append(path)
        images_detailed.append({
            "path": path,
            "description": (img.get("description") or "").strip(),
            "seq": img.get("seq"),
        })
    if image_urls:
        listing["image_urls"] = image_urls
        listing["photo_count"] = len(image_urls)

    # Precise lat/lng — Search response leaves these as None.
    g_map = raw.get("gMap") or {}
    lat = g_map.get("lat")
    lng = g_map.get("lng")
    if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
        listing["geo_lat"] = float(lat)
        listing["geo_lon"] = float(lng)

    # Floor description from yAxis ("二樓") + xAxis ("3室").
    y_axis = (raw.get("yAxis") or "").strip()
    x_axis = (raw.get("xAxis") or "").strip()
    floor_parts = [p for p in (y_axis, x_axis) if p]
    if floor_parts:
        listing["floor"] = " ".join(floor_parts)

    # Nearest MTR (top-level, cross-source).
    label_group = raw.get("labelGroup") or {}
    near_fac = label_group.get("nearbyFacilities") or {}
    mtr_labels = near_fac.get("mtrLabels") or []
    if mtr_labels:
        first = mtr_labels[0] if isinstance(mtr_labels[0], dict) else {}
        station = (first.get("name") or "").strip()
        wm = first.get("walkMinutes")
        if station:
            listing["nearest_mtr_station"] = station
        if isinstance(wm, (int, float)):
            listing["walk_to_mtr_minutes"] = int(wm)

    # Primary agent. Centanet posts multiple agents per listing (often 5-10);
    # we surface the first as the canonical contact and stash the count in
    # extras so the caller knows there are more (full list via agent_contact).
    agents = raw.get("postAgents") or []
    if agents and isinstance(agents[0], dict):
        a = agents[0]
        name_c = (a.get("agentNameC") or "").strip()
        name_e = (a.get("agentNameE") or "").strip()
        if name_c and name_e and name_c != name_e:
            listing["agent_personal"] = f"{name_c} {name_e}"
        else:
            listing["agent_personal"] = name_c or name_e
        license_no = (a.get("agentLicense") or "").strip()
        if license_no:
            listing["agent_license_personal"] = license_no
        listing["agent_company"] = display_name

    # Replace URL with full webUrl if Search-derived url was a path only.
    web_url = (raw.get("webUrl") or "").strip()
    if web_url and listing.get("url", "") != web_url:
        listing["url"] = web_url

    # Source-specific enrichment in source_extras.
    extras = listing.get("source_extras") or {}
    if not isinstance(extras, dict):
        extras = {}

    feature = raw.get("feature") or {}
    topics = feature.get("topics") or []
    feature_tags = [
        t.get("label") for t in topics
        if isinstance(t, dict) and t.get("label")
    ]
    if feature_tags:
        extras["feature_tags"] = feature_tags

    estate_info = raw.get("estateInfo") or {}
    school_net = estate_info.get("schoolNet") or {}
    psn = school_net.get("primarySchoolNetwork")
    if psn:
        extras["school_net_primary"] = str(psn)
    sss = school_net.get("secondarySchoolScope") or {}
    sss_db = sss.get("db")
    if sss_db:
        extras["school_net_secondary_district"] = str(sss_db)

    cat_label = (estate_info.get("catLabelDescription") or "").strip()
    if cat_label:
        extras["cat_label_description"] = cat_label

    mgmt_co = (estate_info.get("managementCompany") or "").strip()
    if mgmt_co:
        extras["management_company"] = mgmt_co

    for k in ("managementInclu", "govRateInclu", "govRentInclu"):
        if raw.get(k) is True:
            extras[k] = True

    # If multiple MTR stations are listed, expose the full list so callers
    # can compare (top-level only surfaces the first / closest).
    if len(mtr_labels) > 1:
        extras["mtr_walk_minutes_all"] = [
            {
                "name": (m.get("name") or "").strip(),
                "walk_minutes": m.get("walkMinutes"),
            }
            for m in mtr_labels
            if isinstance(m, dict) and m.get("name")
        ]

    # Other walk-time labels — useful for "near park" / "near carpark" filters.
    for key, src_key in (
        ("arcade_walk_labels", "arcadeLabels"),
        ("carpark_walk_labels", "carparkLabels"),
        ("park_walk_labels", "largeParkLabels"),
    ):
        items = near_fac.get(src_key) or []
        out = [
            {"name": i.get("name"), "walk_minutes": i.get("walkMinutes")}
            for i in items
            if isinstance(i, dict) and i.get("name")
        ]
        if out:
            extras[key] = out

    if len(agents) > 1:
        extras["agent_count"] = len(agents)

    # Rich postImages with description ("客飯廳" / "廚房" / "浴室" / "交通配套-港鐵站")
    # — the closest signal to "furnished" that Centanet exposes. A listing with
    # interior-room photos (客飯廳/廚房) almost always means it's photo-staged
    # furnished; exterior-only photos suggest empty / shell.
    if images_detailed:
        extras["postImages"] = images_detailed

    if extras:
        listing["source_extras"] = extras

    return listing


async def get_detail(source_id: str) -> Listing:
    """Fetch detail for one Centanet listing.

    ``source_id`` may be:

      - **refNo** (e.g. ``"CGB284"``) — direct hit on ``/api/Post/Detail``
        (single request, no scanning). This is the preferred form and matches
        what users see in the listing URL after the underscore.
      - **Full detail URL** — the refNo is extracted from the path.
      - **UUID** (e.g. ``"e602c53e-6010-cd24-..."``) — falls back to a
        multi-page Search scan (up to 5 pages × 50 = 250 listings) to map
        UUID → refNo, then calls Detail. Slower; prefer refNo when possible.

    Raises ``CentanetFetchError`` if a UUID can't be resolved within the
    scan window — the caller should re-search with narrower filters so the
    listing appears on page 1, or pass the refNo directly.
    """
    sid = str(source_id).strip()
    if not sid:
        raise ValueError("source_id is empty; expected a refNo, UUID, or URL.")

    refno = _extract_refno(sid)
    if refno is None and _UUID_RE.match(sid):
        refno = await _find_refno_by_uuid(sid)
        if refno is None:
            raise CentanetFetchError(
                f"Centanet UUID {sid!r} not found in the first "
                f"{MAX_DETAIL_LOOKUP_PAGES * MAX_PAGE_SIZE} rent listings. "
                "Pass the refNo (e.g. 'CGB284' — the part after the underscore "
                "in the Centanet detail URL) directly, or re-run "
                "search_listings with narrower filters so the listing appears "
                "on an earlier page."
            )

    if refno is None:
        raise ValueError(
            f"source_id {source_id!r} is not a recognized Centanet identifier. "
            "Pass a refNo like 'CGB284' (visible after the underscore in the "
            "detail URL), a full detail URL, or a UUID from a prior search."
        )

    params = {
        "refNo": refno,
        "fromPostType": "Rent",
        "displayTextStyle": "WebDetail",
    }
    raw = await _client.get_json("/api/Post/Detail", params)
    if not raw or not raw.get("refNo"):
        raise CentanetFetchError(
            f"Centanet refNo {refno!r}: /api/Post/Detail returned empty or "
            "malformed response (listing may have been delisted)."
        )
    return _normalize_detail(raw)


def _format_agent_list(agents: list[dict[str, Any]]) -> str:
    """Render postAgents → multi-line summary string for agent_contact."""
    lines: list[str] = []
    for i, a in enumerate(agents, start=1):
        if not isinstance(a, dict):
            continue
        name_c = (a.get("agentNameC") or "").strip()
        name_e = (a.get("agentNameE") or "").strip()
        if name_c and name_e and name_c != name_e:
            name = f"{name_c} ({name_e})"
        else:
            name = name_c or name_e or "(unknown)"
        license_no = (a.get("agentLicense") or "").strip()
        branch = (a.get("branchName") or "").strip()
        mobile = (a.get("agentMobile") or "").strip()
        parts = [f"{i}. {name}"]
        if license_no:
            parts.append(f"[{license_no}]")
        if branch:
            parts.append(f"@ {branch}")
        if mobile:
            parts.append(f"📱 {mobile}")
        lines.append(" ".join(parts))
    return "\n".join(lines)


async def agent_contact(source_id: str) -> AgentContact:
    """Return agent contact info for one Centanet listing.

    Centanet exposes per-listing agent data through ``/api/Post/Detail`` —
    we surface the primary agent's name + EAA license, and stash the full
    multi-agent roster in ``pdpo_warning`` so the caller can pick one
    without an extra HTTP call.
    """
    sid = str(source_id).strip()
    refno = _extract_refno(sid)
    if refno is None and _UUID_RE.match(sid):
        refno = await _find_refno_by_uuid(sid)
    if refno is None:
        raise ValueError(
            f"source_id {source_id!r} is not a recognized Centanet identifier "
            "(expected refNo like 'CGB284', a detail URL, or a UUID)."
        )

    params = {
        "refNo": refno,
        "fromPostType": "Rent",
        "displayTextStyle": "WebDetail",
    }
    raw = await _client.get_json("/api/Post/Detail", params)
    listing = _normalize_detail(raw)

    agents = raw.get("postAgents") or []
    primary = agents[0] if agents and isinstance(agents[0], dict) else {}
    branch = (primary.get("branchName") or "").strip()
    roster = _format_agent_list(agents)

    pdpo = (
        "These contact details are published by each agent on this Centanet "
        "listing's public detail page — public registry data under HK's "
        "Estate Agents Ordinance. Use ONLY to enquire about this property. "
        "Do not redistribute, bulk-collect, or use for marketing (PDPO).\n\n"
        f"Detail URL: {listing.get('url', '(unknown)')}\n\n"
        f"Agents on this listing ({len(agents)}):\n{roster}"
        if agents
        else (
            "Centanet's detail API returned no agent records for this listing. "
            f"Open {listing.get('url', '(unknown)')} in a browser to use the "
            "enquiry form."
        )
    )

    return {
        "source": name,
        "source_id": listing.get("source_id", ""),
        "property_id": refno,
        "title": listing.get("title", ""),
        "building": listing.get("building", ""),
        "district": listing.get("district_name_en", ""),
        "url": listing.get("url", ""),
        "agent_personal": listing.get("agent_personal", ""),
        "agent_company": listing.get("agent_company", "") or display_name,
        "agent_company_address": branch,
        "agent_company_url": "",
        "agent_license_personal": listing.get("agent_license_personal", ""),
        "agent_license_company": "",
        "pdpo_warning": pdpo,
    }
