"""HTML parsing for 28Hse search results and listing detail pages.

Strategy: hybrid JSON-LD + CSS selectors. 28Hse embeds schema.org JSON-LD
which is more reliable than CSS — but doesn't cover every field. We use:

  - **JSON-LD** for: id, url, address, numberOfRooms, floorSize, geo, price,
    currency, agent company name + URL, dates, image list.
  - **CSS** for everything else (bathroom, floor description, furnished
    status, gross area, agent personal name, license numbers, photo count).

If 28Hse changes their CSS class names, the JSON-LD-derived fields keep
working — only the "extras" need re-tuning. That's the resilience design.
"""

from __future__ import annotations

import json
import re
from typing import Any

from selectolax.parser import HTMLParser, Node


# ---------- helpers ----------


def _safe_int(s: Any) -> int | None:
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return int(s)
    m = re.search(r"-?\d+", str(s).replace(",", ""))
    return int(m.group()) if m else None


def _safe_float(s: Any) -> float | None:
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    m = re.search(r"-?\d+(?:\.\d+)?", str(s).replace(",", ""))
    return float(m.group()) if m else None


def _text(n: Node | None, default: str = "") -> str:
    if n is None:
        return default
    return n.text(strip=True, separator=" ")


def _attr(n: Node | None, key: str, default: str = "") -> str:
    if n is None:
        return default
    return n.attributes.get(key, default) or default


def _json_ld_blocks(tree: HTMLParser) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for s in tree.css('script[type="application/ld+json"]'):
        try:
            data = json.loads(s.text())
        except json.JSONDecodeError:
            continue
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    out.append(item)
        elif isinstance(data, dict):
            out.append(data)
    return out


def _find_json_ld(tree: HTMLParser, type_name: str) -> dict[str, Any] | None:
    """Return the first JSON-LD block with the given @type."""
    for blk in _json_ld_blocks(tree):
        if blk.get("@type") == type_name:
            return blk
    return None


def _extract_property_id_from_url(url: str) -> int | None:
    m = re.search(r"/property-(\d+)", url)
    return int(m.group(1)) if m else None


# ---------- search page parsing ----------


def parse_search_results(html: str) -> dict[str, Any]:
    """Parse a 28Hse search result page.

    Returns ``{"total": int, "page": int, "results": [Listing, ...]}``
    where each Listing is a dict with summary fields (full detail requires
    a separate fetch of the detail page).
    """
    tree = HTMLParser(html)
    item_list = _find_json_ld(tree, "ItemList") or {}

    # Total count: prefer JSON-LD numberOfItems; fall back to "X results" text.
    total = _safe_int(item_list.get("numberOfItems"))
    if total is None:
        total = _parse_total_results_from_text(tree)

    # URL → property_id map from JSON-LD itemListElement (order-preserving).
    url_by_pos: dict[int, str] = {}
    image_by_pos: dict[int, str] = {}
    for el in item_list.get("itemListElement", []) or []:
        pos = el.get("position")
        if isinstance(pos, int):
            url_by_pos[pos] = el.get("url", "")
            image_by_pos[pos] = el.get("image", "")

    results: list[dict[str, Any]] = []
    for idx, card in enumerate(tree.css(".item.property_item"), start=1):
        listing = _parse_search_card(card)
        # Backfill from JSON-LD if HTML didn't yield a URL.
        if not listing.get("url") and idx in url_by_pos:
            listing["url"] = url_by_pos[idx]
            listing["property_id"] = _extract_property_id_from_url(url_by_pos[idx])
        if not listing.get("image") and idx in image_by_pos:
            listing["image"] = image_by_pos[idx]
        results.append(listing)

    return {"total": total, "results": results}


def _parse_total_results_from_text(tree: HTMLParser) -> int | None:
    """Look for 'Total N results' style text anywhere on the page."""
    for n in tree.css(".totalResult, .total_result, .search_count, h1, h2"):
        m = re.search(r"(\d[\d,]+)\s*(?:results|個結果)", n.text())
        if m:
            return _safe_int(m.group(1))
    return None


def _parse_search_card(card: Node) -> dict[str, Any]:
    """Parse one ``.item.property_item`` block from the search results page."""
    link = card.css_first("a.detail_page")
    url = _attr(link, "href")
    property_id = _safe_int(_attr(link, "attr1")) or _extract_property_id_from_url(url)

    title = _text(card.css_first(".header a"))

    # District / building / unit description
    district_area = card.css_first(".district_area")
    districts: list[str] = []
    if district_area is not None:
        for a in district_area.css("a"):
            t = _text(a)
            if t:
                districts.append(t)
    district_name = districts[0] if districts else ""
    building_name = districts[1] if len(districts) > 1 else ""
    unit_desc = _text(card.css_first(".unit_desc"))

    # Area / unit price
    area_text = _text(card.css_first(".areaUnitPrice"))
    saleable_ft = _parse_saleable_area(area_text)
    gross_ft = _parse_gross_area(area_text)

    # Agent company
    company = _text(card.css_first(".companyName"))
    # Strip the leading icon glyph if any
    company = re.sub(r"^[\s\W]+", "", company).strip()

    # Price (the green "Lease HKD$10,500" label)
    price_text = _text(card.css_first(".extra .label"))
    price_hkd = _safe_int(re.sub(r"[^\d]", "", price_text)) if price_text else None

    # Photo count
    photo_count = _safe_int(_text(card.css_first(".myimage_count .label")))

    # Quality grade label (e.g. "Golden")
    grade = _text(card.css_first(".grade_label"))

    # Timestamp ("1 day ago posted")
    posted_text = ""
    for label in card.css(".description .right.floated .label"):
        t = _text(label)
        if "ago" in t or "posted" in t.lower():
            posted_text = t
            break

    # Image
    image_url = _attr(card.css_first("img.detail_page_img"), "src")

    # Inferred property type from URL (apartment / office / village / etc).
    prop_type = _infer_type_from_url(url)

    return {
        "property_id": property_id,
        "url": url,
        "title": title,
        "district": district_name,
        "building": building_name,
        "unit_desc": unit_desc,
        "saleable_ft": saleable_ft,
        "gross_ft": gross_ft,
        "agent_company": company,
        "price_hkd": price_hkd,
        "photo_count": photo_count,
        "grade": grade,
        "posted_text": posted_text,
        "image": image_url,
        "property_type": prop_type,
    }


def _infer_type_from_url(url: str) -> str:
    if "/rent/" in url:
        for t in ("apartment", "village", "shop", "office", "industrial", "carpark", "service-apartment"):
            if f"/{t}/" in url or f"/{t}-" in url:
                return t
    return ""


_SALEABLE_RE = re.compile(r"Saleable Area[:\s]*(\d[\d,]*)\s*ft", re.IGNORECASE)
_GROSS_RE = re.compile(r"Gross Area[:\s]*(\d[\d,]*)\s*ft", re.IGNORECASE)


def _parse_saleable_area(text: str) -> int | None:
    if not text:
        return None
    m = _SALEABLE_RE.search(text)
    return _safe_int(m.group(1)) if m else None


def _parse_gross_area(text: str) -> int | None:
    if not text:
        return None
    m = _GROSS_RE.search(text)
    return _safe_int(m.group(1)) if m else None


# ---------- detail page parsing ----------


def parse_listing_detail(html: str) -> dict[str, Any]:
    """Parse a 28Hse listing detail page (rent or buy).

    Returns a flat dict with as many fields as we can recover.
    """
    transport_items = parse_transportation_items(html)
    nearest_mtr = pick_nearest_mtr(transport_items)
    tree = HTMLParser(html)

    item_page = _find_json_ld(tree, "ItemPage") or {}
    main = item_page.get("mainEntity") or {}
    offers = item_page.get("offers") or {}
    agent_org = offers.get("offeredBy") or {}

    url = item_page.get("url", "")
    property_id = _extract_property_id_from_url(url)

    # Floor size from JSON-LD (this is saleable, per inspection).
    floor_size = main.get("floorSize") or {}
    saleable_ft = _safe_int(floor_size.get("value"))

    # Geo (bonus: lat/lon)
    geo = main.get("geo") or {}

    # Price: JSON-LD has "Lease HKD$10,500 " — extract number.
    price_text = offers.get("price", "")
    price_hkd = _safe_int(re.sub(r"[^\d]", "", price_text)) if price_text else None
    currency = offers.get("priceCurrency", "HKD")

    # Bedrooms from JSON-LD (numberOfRooms is sometimes wrong for studios — fall back to text).
    bedrooms = _safe_int(main.get("numberOfRooms"))

    # ----- HTML-only extras -----
    bathroom_count = _scrape_bathroom(tree)
    if bedrooms is None or bedrooms == 0:
        bedrooms = _scrape_bedroom(tree)
    floor_desc = _scrape_floor(tree)
    furnished = _scrape_furnished(tree)
    gross_ft = _scrape_gross_area(tree)
    agent_personal = _scrape_agent_personal(tree, agent_org.get("name", ""))
    license_personal, license_company = _scrape_agent_licenses(tree)
    photo_count = _scrape_photo_count(tree)

    return {
        "property_id": property_id,
        "url": url,
        "title": item_page.get("name", "").strip(),
        "description": item_page.get("description", ""),
        "address": main.get("address", ""),
        "building": _scrape_building(tree, main.get("keywords", "")),
        "district": _scrape_district(tree),
        "price_hkd": price_hkd,
        "currency": currency,
        "saleable_ft": saleable_ft,
        "gross_ft": gross_ft,
        "bedrooms": bedrooms,
        "bathrooms": bathroom_count,
        "floor": floor_desc,
        "furnished": furnished,
        "photo_count": photo_count,
        "agent_company": agent_org.get("name", ""),
        "agent_company_address": agent_org.get("address", ""),
        "agent_company_url": agent_org.get("url", ""),
        "agent_personal": agent_personal,
        "agent_license_personal": license_personal,
        "agent_license_company": license_company,
        "geo_lat": _safe_float(geo.get("latitude")),
        "geo_lon": _safe_float(geo.get("longitude")),
        "date_published": item_page.get("datePublished", ""),
        "date_modified": item_page.get("dateModified", ""),
        "image_urls": _scrape_image_urls(item_page),
        "transport_items": transport_items,
        "nearest_mtr_station": (nearest_mtr or {}).get("name", ""),
        "walk_to_mtr_minutes": (nearest_mtr or {}).get("walk_minutes"),
    }


# ----- HTML scrapers for fields not in JSON-LD -----

_BEDROOM_RE = re.compile(r"(\d+)\s*Bedroom|Studio", re.IGNORECASE)
_BATHROOM_RE = re.compile(r"(\d+)\s*Bathroom", re.IGNORECASE)


def _scrape_bedroom(tree: HTMLParser) -> int | None:
    """Look for 'Studio' (=> 0) or 'N Bedroom' in meta description or page."""
    meta = tree.css_first('meta[name="description"]')
    txt = _attr(meta, "content") if meta is not None else ""
    if not txt:
        # Fallback: scan page text
        title = tree.css_first("title")
        txt = _text(title)
    if "Studio" in txt:
        return 0
    m = _BEDROOM_RE.search(txt)
    return _safe_int(m.group(1)) if m and m.group(1) else None


def _scrape_bathroom(tree: HTMLParser) -> int | None:
    meta = tree.css_first('meta[name="description"]')
    txt = _attr(meta, "content")
    if txt:
        m = _BATHROOM_RE.search(txt)
        if m:
            return _safe_int(m.group(1))
    return None


# Match strings like "Mid Floor(15-25|29/F)" or "Middle Floor (15-25, 29/F)".
_FLOOR_RE = re.compile(
    r"(?:High|Middle|Mid|Low)\s*Floor\s*[(\[]?[\d\s\-|,/F]+\)?",
    re.IGNORECASE,
)


def _scrape_floor(tree: HTMLParser) -> str:
    """Find a floor description like 'Middle Floor (15-25, 29/F)'."""
    meta = tree.css_first('meta[name="description"]')
    txt = _attr(meta, "content")
    if txt:
        m = _FLOOR_RE.search(txt)
        if m:
            return m.group(0).strip()
    # Fallback: search visible page text
    for n in tree.css("td, div, span"):
        t = _text(n)
        if 5 < len(t) < 80 and "/F" in t and ("Floor" in t or "Mid" in t or "High" in t or "Low" in t):
            return t
    return ""


def _scrape_furnished(tree: HTMLParser) -> str:
    """Find 'With Furniture' / 'Partially Furnished' / 'Without Furniture'."""
    for keyword in ("Partially Furnished", "With Furniture", "Without Furniture",
                    "With Electrical Appliance", "Fully Furnished"):
        for n in tree.css("div, td, span"):
            t = _text(n)
            if t == keyword or t.endswith(keyword):
                return keyword
    return ""


def _scrape_gross_area(tree: HTMLParser) -> int | None:
    """Try to find Gross Area in a table cell."""
    for tr in tree.css("tr"):
        cells = [_text(td) for td in tr.css("td")]
        for i, c in enumerate(cells):
            if c.lower().startswith("gross area") and i + 1 < len(cells):
                m = re.search(r"\d[\d,]*", cells[i + 1])
                if m:
                    return _safe_int(m.group())
    return None


def _scrape_agent_personal(tree: HTMLParser, agent_company: str = "") -> str:
    """Find the personal agent name (e.g. 'Sena Tang').

    The first ``h4.ui.header`` is the company name; the second is the personal
    agent's name (often followed by 'Name Card'). We strip trailing UI
    boilerplate and exclude the company-name match.
    """
    company_lower = agent_company.lower().strip()
    for h in tree.css("h4.ui.header"):
        t = _text(h)
        # Strip trailing 'Name Card' / 'Tel' / etc.
        t = re.sub(r"\s*(Name Card|Tel|Email|Contact)\s*$", "", t, flags=re.IGNORECASE).strip()
        if not t or len(t) > 50:
            continue
        if company_lower and t.lower() == company_lower:
            continue
        if any(w in t.lower() for w in ("license", "id#", "no:", "property", "agent", "search", "result")):
            continue
        return t
    return ""


_LICENSE_PERSONAL_RE = re.compile(r"Personal License Number[:\s]*([SC]-\d+)", re.IGNORECASE)
_LICENSE_COMPANY_RE = re.compile(r"Company License Number[:\s]*([SC]-\d+)", re.IGNORECASE)


def _scrape_agent_licenses(tree: HTMLParser) -> tuple[str, str]:
    body_text = tree.body.text() if tree.body else ""
    p = _LICENSE_PERSONAL_RE.search(body_text)
    c = _LICENSE_COMPANY_RE.search(body_text)
    return (p.group(1) if p else "", c.group(1) if c else "")


def _scrape_photo_count(tree: HTMLParser) -> int | None:
    n = tree.css_first(".myimage_count .label")
    return _safe_int(_text(n)) if n is not None else None


def _scrape_building(tree: HTMLParser, keywords: str = "") -> str:
    """Find the building/estate name.

    Preferred: the 2nd token of JSON-LD ``mainEntity.keywords`` (28Hse format
    is ``"District,Building,Page,Phase"``).
    Fallback: an estate breadcrumb link.
    """
    if keywords:
        parts = [p.strip() for p in keywords.split(",") if p.strip()]
        if len(parts) >= 2:
            return parts[1]
    for a in tree.css("a"):
        href = _attr(a, "href")
        if "/estate/" in href:
            t = _text(a)
            if t and len(t) < 60 and not t.startswith("#") and t.lower() != "estate":
                return t
    return ""


def _scrape_district(tree: HTMLParser) -> str:
    """Find the district name from breadcrumb."""
    # Breadcrumbs typically: HK > Region > District > Building
    for a in tree.css(".district_area a, .breadcrumb a, .section a"):
        href = _attr(a, "href")
        if "/dg" in href:
            return _text(a)
    return ""


def _scrape_image_urls(item_page: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for img in item_page.get("image", []) or []:
        if isinstance(img, dict) and img.get("url"):
            out.append(img["url"])
        elif isinstance(img, str):
            out.append(img)
    return out


# Matches "Tuen Mun( MTR )", "兆康( 西鐵 )", "Ching Tin Estate( Bus Stop )" —
# captures station/stop name and the parenthetical transit type.
_TRANSPORT_TYPE_RE = re.compile(r"^(.*?)\(\s*([^)]+?)\s*\)\s*$")
# 28Hse uses "N min Walk" (EN) / "N 分鐘步程" (ZH).
_WALK_MIN_RE = re.compile(r"(\d+)\s*(?:min|分鐘)")
# MTR-like station markers — accept English ("MTR", "Light Rail") and Chinese
# ("港鐵", "輕鐵", "西鐵", "東鐵") variants.
_MTR_TOKENS = ("MTR", "Light Rail", "港鐵", "輕鐵", "西鐵", "東鐵", "屯馬", "Tuen Ma")


def parse_transportation_items(html: str) -> list[dict[str, Any]]:
    """Return the 28Hse detail page's "Trans" (nearby transport) rows.

    Each entry: ``{"name": str, "type": str, "walk_minutes": int | None}``.
    The 28Hse markup is a ``field="TransportationItems"`` row containing two
    columns — the stop label (e.g. ``"Tuen Mun( MTR )"``) on the left and a
    walk-distance string (e.g. ``"2 min Walk"``) on the right.
    """
    out: list[dict[str, Any]] = []
    tree = HTMLParser(html)
    for row in tree.css('div[field="TransportationItems"]'):
        cols = row.css("div.column")
        if len(cols) < 2:
            continue
        label = _text(cols[0]).strip()
        distance = _text(cols[1]).strip()
        if not label:
            continue
        m = _TRANSPORT_TYPE_RE.match(label)
        if m:
            name = m.group(1).strip()
            ttype = m.group(2).strip()
        else:
            name = label
            ttype = ""
        wm: int | None = None
        m2 = _WALK_MIN_RE.search(distance)
        if m2:
            wm = int(m2.group(1))
        out.append({"name": name, "type": ttype, "walk_minutes": wm})
    return out


def pick_nearest_mtr(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Pick the closest MTR-like station from a Transportation items list.

    "MTR-like" = the parenthetical type contains any of MTR / Light Rail /
    港鐵 / 輕鐵 / 西鐵 / 東鐵 / 屯馬 / Tuen Ma. Returns the entry with the
    smallest ``walk_minutes`` (ties broken by list order), or ``None`` when
    the listing has no rail option in walking distance.
    """
    candidates = [
        i for i in items
        if any(tok in (i.get("type") or "") for tok in _MTR_TOKENS)
    ]
    if not candidates:
        return None
    # Treat unknown walk_minutes as +inf so they sort last.
    candidates.sort(key=lambda i: (i.get("walk_minutes") is None,
                                   i.get("walk_minutes") or 10**9))
    return candidates[0]
