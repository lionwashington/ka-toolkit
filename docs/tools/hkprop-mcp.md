# hkprop-mcp

MCP server for searching Hong Kong rental property on **[28Hse.com](https://www.28hse.com)**.
Personal-use dogfood — surfaces 28Hse's public listings (the same ones any
visitor sees in their browser) through a Claude/MCP-friendly interface so an
LLM agent can search by district, price, room count, and size.

**Not for redistribution.** This package fetches publicly-rendered HTML for
personal apartment-hunting workflows. Do not deploy as a SaaS, scrape
in bulk for resale, or use to compete with 28Hse.

---

## Status

- **5 tools** live and tested against **2 sources** on 2026-05-25:
  - **28Hse** (HTML scrape — JSON-LD discovery + CSS selectors)
  - **Centanet 中原地產** (REST API direct — clean JSON)
  - **Google Maps Directions** (transit commute — for `commute_to_school`)
- **113 unit tests pass** (parser fixtures, URL builder, district lookup,
  dispatcher, source registry, normalization, Centanet param building,
  aggregate de-dupe, commute key-loading + time-parsing + summarization,
  commute dispatch over both id-string and dict input paths).
- Live smoke tests:
  - 28Hse HK-wide (no district) → 17,395 results in 0.9s
  - 28Hse Tuen Mun 10K-15K 2-room 350+ft² → 354 results in 0.5s
  - Centanet Tuen Mun 10K-15K 2-room 350+ft² → 2,027 total / 6 in TM page 1 in 0.9s
  - **source="all"** Tuen Mun 10K-15K 2+ → 28Hse 11 + Centanet 3 = 14 deduped in 1.0s
  - **commute_to_school** Novo Land (28hse) → school = 35 min (walk 2 + bus K54→K51, 1 transfer)
  - **commute_to_school** 麗虹花園 1座 (Centanet, no geo → address-fallback geocode) → school = 38 min (walk 5 + LRT 751 → bus 261X, 1 transfer)
- **Source-agnostic architecture**: each source is a single file under
  ``sources/`` implementing a 3-method Protocol. New sources plug in
  without changing any tool schema.

## Tools

| Tool | Signature |
|---|---|
| `search_listings` | `(district?, building_type, min_price?, max_price?, min_rooms?, min_size?, max_size?, furnished?, page, source)` — **district is optional**; omit it for HK-wide results. |
| `get_listing_detail` | `(property_id, source)` — full normalized listing. |
| `list_districts` | `()` — all 62 districts, 4 regions, 7 property types, and registered sources. |
| `agent_contact` | `(property_id, source)` — agent + license + PDPO warning. |
| `commute_to_school` | `(property_id, source, school?, departure_time?)` — Google Maps transit time from listing → school. `property_id` accepts either a string id **or a Listing dict** (skips lookup — recommended when you already have the listing from a prior `search_listings` call; required on Centanet for any listing outside the unfiltered top-50). Default destination: Victoria Harbour, Hong Kong (a neutral landmark; pass your own). Default departure: next weekday 08:00 HKT. Returns total / walking / transit minutes, transfers, step-by-step instructions, fare. |

All tools accept a ``source`` argument (default ``"28hse"``). Accepted values:

- ``"28hse"`` — HTML scrape (17K+ HK listings)
- ``"centanet"`` — Centanet REST API direct (12K+ HK rent listings, schema is
  richer per record: bedroom count, building age, direction, HMA sub-district)
- ``"all"`` — fan-out across every registered source, merge + dedupe by
  (building, address, price)

## Install / Setup

Once the package and venv are installed on the machine:

- Code: `<repo>/kb/tools/hkprop-mcp/`
- Venv: `~/.knowledge-assistant/kb/venvs/hkprop/`
- MCP entry: `~/.claude.json` → `mcpServers.hkprop`

**To activate**: restart Claude Code. The tools appear as:

- `mcp__hkprop__search_listings`
- `mcp__hkprop__get_listing_detail`
- `mcp__hkprop__list_districts`
- `mcp__hkprop__agent_contact`
- `mcp__hkprop__commute_to_school`

### Google Maps API key (required for `commute_to_school`)

Add to `~/.knowledge-assistant/secrets.yaml`:
```yaml
google_maps_api_key: AIza...
```
Or export `GOOGLE_MAPS_API_KEY=AIza...`. Enable **Directions API** + **Geocoding API**
in the GCP console. Free tier ($200/month credit ≈ 40K requests) easily covers
personal apartment-hunting use.

## Examples (in an MCP-aware agent)

```
# HK-wide — see everything in your budget across all 18 districts
search_listings(min_price=10000, max_price=15000, min_rooms=2, min_size=350)
→ 17,395 listings on page 1

# District-specific (Tuen Mun)
search_listings(district="Tuen Mun", min_price=10000, max_price=15000,
                min_rooms=2, min_size=350)
→ 354 listings on page 1

# Chinese district name resolves
search_listings(district="屯門", building_type="apartment", min_price=12000,
                max_price=18000, min_rooms=2, min_size=400, page=2)

# Detail (returns normalized Listing — same shape regardless of source)
get_listing_detail("3860784")

# All districts + sources discoverable
list_districts()

# Agent contact (carries PDPO warning)
agent_contact("3860784")

# Commute from a listing to a destination (default = Victoria Harbour)
commute_to_school("3860784", source="28hse")
→ {
    "total_minutes": 35, "walking_minutes": 2, "transit_minutes": 27, "transfers": 1,
    "steps": [
      {"mode": "WALKING", "duration_min": 1, "instructions": "步行到菁田邨"},
      {"mode": "TRANSIT", "duration_min": 16, "line": "K54", "vehicle": "BUS",
       "from": "菁田邨", "to": "屯門市中心", "num_stops": 5},
      ...
    ],
    "departure_time": "上午8:02", "arrival_time": "上午8:37",
    "listing": {"source": "28hse", "building": "Novo Land", "price_hkd": 10500, ...}
  }

# Specify a different school + a specific weekday morning
commute_to_school("e602c53e-6010-cd24-139a-08de06ff6b08", source="centanet",
                  school="Hong Kong University of Science and Technology",
                  departure_time="2026-06-01T08:30:00+08:00")

# Pass a Listing dict directly — skips the lookup step, recommended for
# batch commute over Centanet search results (Centanet's public API has
# no per-id endpoint, so id-lookup fails for any listing outside the
# unfiltered top-50; passing the dict you already have sidesteps this).
result = await search_listings(district="Tuen Mun", min_price=8000,
                               max_price=13000, min_rooms=2,
                               source="centanet")
for listing in result["results"]:
    commute_to_school(listing)  # dict path — zero extra requests
```

## URL construction (for debugging)

- Search: `https://www.28hse.com/en/rent/{type}/{region}/{district}[/page-N]?rent_from=...&rent_to=...&room=...&size_from=...&size_to=...`
- Detail: `https://www.28hse.com/en/rent/{type}/property-{id}`

Region codes: `a1`=HK Island, `a2`=Kowloon, `a3`=NT, `a4`=Islands.
Example district codes: Tuen Mun `dg48`, Yuen Long `dg47`, Tin Shui Wai `dg49`,
Tsuen Wan `dg44`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `HKPROP_BASE_URL` | `https://www.28hse.com` | Base URL. Override for local testing only. |
| `HKPROP_LANG` | `en` | URL language prefix (`en` / `zh-hk`). `en` is the most stable. |
| `HKPROP_TIMEOUT_S` | `15` | HTTP timeout per request. |
| `HKPROP_MIN_REQUEST_INTERVAL_S` | `1.0` | Min seconds between requests (rate limit). |
| `HKPROP_USER_AGENT` | (real Safari UA + hkprop-mcp/0.1 marker) | Identifies this client honestly. |

## Architecture

```
src/hkprop_mcp/
├── server.py             FastMCP, 4 @mcp.tool() functions (source-agnostic schemas)
├── tools.py              Dispatcher + source="all" fan-out + de-dupe
├── models.py             Listing / SearchResult / AgentContact TypedDicts
├── districts.py          62 HK districts + 4 regions + 7 property types
├── client.py             httpx AsyncClient for 28Hse HTML (shared, rate-limited)
├── parser.py             28Hse HTML / JSON-LD parser
└── sources/
    ├── base.py           Source Protocol
    ├── __init__.py       Registry: {"28hse": ..., "centanet": ...}
    ├── twentyeighthse.py 28Hse HTML scrape source
    └── centanet.py       Centanet REST API source (own httpx client)
```

### Adding a new source (V2)

1. Create ``sources/centanet.py`` (or ``spacious.py``) with ``name``,
   ``display_name``, and async ``search`` / ``get_detail`` /
   ``agent_contact`` matching ``sources/base.Source`` Protocol.
2. Map its raw output → ``Listing`` (the source-specific normalizer).
3. Add the module to ``SOURCES`` in ``sources/__init__.py``.

The MCP tool schemas don't change. Callers just pass ``source="centanet"``.

### Parsing strategy

**JSON-LD first, CSS fallback.** 28Hse embeds schema.org ``ItemPage`` and
``ItemList`` blocks with address, geo, price, area, and agent organization.
Fields not in JSON-LD (bathroom count, floor description, furnished status,
agent's personal name, license numbers) come from targeted CSS scrapes. If
28Hse renames a CSS class, JSON-LD-derived fields keep working — only the
narrow set of HTML-only fields needs re-tuning.

## Known limitations / caveats

- **URL filter params are approximate.** 28Hse honors `rent_from`/`rent_to`
  reliably but `room` and `size_from` sometimes return matches outside the
  range (e.g. a 242ft² studio shows up in a 350+ft² 2-room query). The agent
  should verify against the per-listing `saleable_ft` and `bedrooms` fields
  from `get_listing_detail`.
- **Furnished filter is post-hoc only.** The search card doesn't expose
  furnishing status; you have to fetch detail to know. Tag listings with
  `furnished_filter_note` if you pass a `furnished` arg.
- **Photo count on detail page returns null.** That field is search-only.
- **Phone numbers not exposed** — 28Hse gates phones behind a contact form.
  Use the company address from `agent_contact` and call the company directly.

## Testing

```bash
cd <repo>/kb/tools/hkprop-mcp
~/.knowledge-assistant/kb/venvs/hkprop/bin/python -m pytest tests/ -v
```

## Why 28Hse + Centanet?

| Site | Method | Why |
|---|---|---|
| **28Hse** | HTML scrape (JSON-LD discovery) | Fully open robots.txt, no published ToS, SSR HTML, no Cloudflare. No internal listing API exists (probed). |
| **Centanet** | REST API direct | Clean JSON API found by reverse-engineering Nuxt JS bundle (`/api/Post/Search`). Schema is richer per record than 28Hse. robots.txt blocks AI-named crawlers but the API is for browser SPAs — used here with a real Safari User-Agent. |
| Spacious | not used | Has anti-bot edge (returns 403). Better AI signal (allows GPTBot) but harder MVP. |
| GoHome | not used | 301-redirects to 28Hse (defunct / merged). |
| Squarefoot | not used | Sister site of 28Hse (same parent). Potential V2 redundancy. |
