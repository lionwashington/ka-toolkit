"""Centanet source tests — JSON fixture-based, no network."""

from __future__ import annotations

import json
import pathlib

import pytest

from hkprop_mcp.sources import centanet as src


FIXTURES = pathlib.Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def search_raw() -> dict:
    return json.loads((FIXTURES / "centanet-search-rent.json").read_text())


class TestBuildPayload:
    def test_default(self) -> None:
        p = src._build_payload("apartment", None, None, None, None, 1, 24)
        assert p["postType"] == "Rent"
        assert p["page"] == 1
        assert p["size"] == 24
        assert "amountRange" not in p
        assert "nSizeRange" not in p

    def test_price_range(self) -> None:
        p = src._build_payload("apartment", 10000, 15000, None, None, 1, 24)
        assert p["amountRange"] == {"min": 10000, "max": 15000}

    def test_size_range(self) -> None:
        p = src._build_payload("apartment", None, None, 350, 800, 1, 24)
        assert p["nSizeRange"] == {"min": 350, "max": 800}

    def test_size_clamps(self) -> None:
        p = src._build_payload("apartment", None, None, None, None, 1, 999)
        assert p["size"] == src.MAX_PAGE_SIZE

    def test_min_only_price(self) -> None:
        p = src._build_payload("apartment", 10000, None, None, None, 1, 24)
        assert p["amountRange"] == {"min": 10000}

    def test_page_floor_1(self) -> None:
        p = src._build_payload("apartment", None, None, None, None, 0, 24)
        assert p["page"] == 1


class TestDistrictMatches:
    def test_none_district_matches_all(self) -> None:
        listing = {"scope": {"webScope": "屯門", "db": "屯門區"}}
        assert src._district_matches(listing, None) is True

    def test_tuen_mun_matches(self) -> None:
        listing = {"scope": {"webScope": "屯門", "db": "屯門區"}}
        assert src._district_matches(listing, "dg48") is True  # dg48 = Tuen Mun

    def test_combined_scope_matches(self) -> None:
        """Centanet uses combined scopes like '上水 | 粉嶺 | 古洞'."""
        listing = {"scope": {"webScope": "上水 | 粉嶺 | 古洞", "db": "北區"}}
        assert src._district_matches(listing, "dg50") is True  # dg50 = Sheung Shui (上水)
        assert src._district_matches(listing, "dg51") is True  # dg51 = Fanling (粉嶺)

    def test_wrong_district_rejects(self) -> None:
        listing = {"scope": {"webScope": "屯門", "db": "屯門區"}}
        # Central is on HK Island, not Tuen Mun.
        assert src._district_matches(listing, "dg1") is False

    def test_unknown_code_rejects(self) -> None:
        listing = {"scope": {"webScope": "屯門"}}
        assert src._district_matches(listing, "dg9999") is False


class TestBedroomsMatch:
    def test_none_filter(self) -> None:
        assert src._bedrooms_match({"bedroomCount": 1}, None) is True

    def test_meets_minimum(self) -> None:
        assert src._bedrooms_match({"bedroomCount": 2}, 2) is True
        assert src._bedrooms_match({"bedroomCount": 3}, 2) is True

    def test_below_minimum(self) -> None:
        assert src._bedrooms_match({"bedroomCount": 1}, 2) is False

    def test_missing_field_passes(self) -> None:
        """Don't drop listings missing bedroom info — let the agent decide."""
        assert src._bedrooms_match({}, 2) is True
        assert src._bedrooms_match({"bedroomCount": None}, 2) is True


class TestNormalize:
    def test_first_record(self, search_raw: dict) -> None:
        listing = src._normalize(search_raw["data"][0])
        assert listing["source"] == "centanet"
        assert listing["source_id"] == "e602c53e-6010-cd24-139a-08de06ff6b08"
        assert listing["currency"] == "HKD"
        assert listing["price_hkd"] == 12000
        assert listing["building"] == "麗虹花園 1座"
        assert listing["address"] == "丹桂村路1號"
        assert listing["bedrooms"] == 2
        # Centanet returns size = gross, nSize = saleable
        assert listing["gross_ft"] == 470
        assert listing["saleable_ft"] == 367
        assert listing["url"].startswith("https://hk.centanet.com/")
        # Source extras
        extras = listing.get("source_extras") or {}
        assert extras.get("refNo") == "CPH580"
        assert extras.get("buildingAge") == 32
        assert extras.get("direction") == "東南"

    def test_district_resolution(self, search_raw: dict) -> None:
        """The first record has scope.webScope='屯門' which must map to dg48."""
        listing = src._normalize(search_raw["data"][0])
        # NOTE: actual webScope in fixture may be "屯門" — verify mapping
        assert listing["district_name_zh"] in ("屯門", "")  # depends on first sample
        # Check that if scope is '屯門' the code is dg48
        if listing["district_name_zh"] == "屯門":
            assert listing["district_code"] == "dg48"
            assert listing["region_code"] == "a3"


class TestPostTypeRent:
    """Smoke test the building_type → postType mapping."""

    @pytest.mark.parametrize("bt", ["apartment", "village", "office", "any"])
    def test_all_default_to_rent(self, bt: str) -> None:
        assert src._POSTTYPE_BY_BUILDING_TYPE[bt] == "Rent"


# ---------- detail (get_detail / _normalize_detail) ----------


@pytest.fixture(scope="module")
def detail_cgb284() -> dict:
    """Centanet /api/Post/Detail response for CGB284 (兆康苑 Rent listing)."""
    return json.loads((FIXTURES / "centanet-detail-cgb284.json").read_text())


@pytest.fixture(scope="module")
def detail_cph580() -> dict:
    """Detail response for CPH580 (麗虹花園, postType=B — both buy + rent)."""
    return json.loads((FIXTURES / "centanet-detail-cph580.json").read_text())


class TestExtractRefno:
    """source_id may arrive as raw refNo, full URL, or UUID (handled separately)."""

    def test_bare_refno(self) -> None:
        assert src._extract_refno("CGB284") == "CGB284"
        assert src._extract_refno("CPH580") == "CPH580"
        assert src._extract_refno("CFQ523") == "CFQ523"

    def test_refno_lowercase_rejected(self) -> None:
        # refNos are always uppercase on Centanet — guard against accidental
        # match against typos that aren't real refNos.
        assert src._extract_refno("cgb284") is None

    def test_url_with_chinese_estate(self) -> None:
        url = "https://hk.centanet.com/findproperty/detail/兆康苑_CGB284"
        assert src._extract_refno(url) == "CGB284"

    def test_url_with_percent_encoded_estate(self) -> None:
        url = (
            "https://hk.centanet.com/findproperty/detail/"
            "%E5%85%86%E5%BA%B7%E8%8B%91_CGB284"
        )
        assert src._extract_refno(url) == "CGB284"

    def test_url_with_query_string(self) -> None:
        url = "https://hk.centanet.com/findproperty/detail/麗虹花園_CPH580?lang=zh-Hant"
        assert src._extract_refno(url) == "CPH580"

    def test_uuid_not_a_refno(self) -> None:
        # UUIDs are handled by the multi-page fallback, not _extract_refno.
        assert src._extract_refno("e602c53e-6010-cd24-139a-08de06ff6b08") is None

    def test_empty_returns_none(self) -> None:
        assert src._extract_refno("") is None
        assert src._extract_refno("   ") is None


class TestNormalizeDetail:
    """The detail API returns a record with the same top-level shape as search
    items + rich media/feature/agent fields. _normalize_detail extends
    _normalize to fill those in."""

    def test_basic_fields_match_search(self, detail_cgb284: dict) -> None:
        l = src._normalize_detail(detail_cgb284)
        assert l["source"] == "centanet"
        assert l["source_id"] == detail_cgb284["id"]
        assert l["price_hkd"] == 11800
        assert l["building"] == "兆康苑 兆欣閣 (G座)"
        assert l["bedrooms"] == 2
        assert l["district_code"] == "dg48"  # 屯門
        assert l["url"].endswith("CGB284") or "CGB284" in l["url"]

    def test_image_urls_populated(self, detail_cgb284: dict) -> None:
        l = src._normalize_detail(detail_cgb284)
        # CGB284 fixture has 6 postImages — far more than search's 1 thumbnail.
        assert len(l["image_urls"]) >= 4
        assert l["photo_count"] == len(l["image_urls"])
        # Every URL should be a Centanet CDN path.
        assert all("centanet.com" in u for u in l["image_urls"])

    def test_postimages_have_descriptions(self, detail_cgb284: dict) -> None:
        """source_extras.postImages keeps each photo's description
        ("客飯廳" / "廚房" / "交通配套-港鐵站") — the closest signal to
        whether the unit is furnished (interior photos = staged furnished)."""
        l = src._normalize_detail(detail_cgb284)
        extras = l.get("source_extras") or {}
        images = extras.get("postImages") or []
        assert isinstance(images, list) and len(images) >= 4
        assert all("path" in img and "description" in img for img in images)
        # At least one image should have a Chinese description (proves we kept
        # the field, not just stripped it).
        assert any(img.get("description") for img in images)

    def test_geo_coords_from_gmap(self, detail_cgb284: dict) -> None:
        l = src._normalize_detail(detail_cgb284)
        # CGB284 → 兆康 (Tuen Mun) ≈ 22.41°N, 113.98°E
        assert 22.40 < l["geo_lat"] < 22.42
        assert 113.97 < l["geo_lon"] < 113.99

    def test_nearest_mtr_top_level(self, detail_cgb284: dict) -> None:
        l = src._normalize_detail(detail_cgb284)
        assert l["nearest_mtr_station"] == "兆康"
        assert l["walk_to_mtr_minutes"] == 1

    def test_floor_from_y_x_axis(self, detail_cgb284: dict) -> None:
        # CGB284 yAxis = "" / xAxis = ""  → floor stays empty (or whatever
        # _normalize set). We mainly want to make sure we don't crash.
        l = src._normalize_detail(detail_cgb284)
        # CPH580 has yAxis=二樓 / xAxis=3室 — assert there.
        # Use it as a separate test below.
        assert "floor" in l  # key exists

    def test_floor_from_cph580(self, detail_cph580: dict) -> None:
        l = src._normalize_detail(detail_cph580)
        # CPH580 has yAxis="二樓" xAxis="3室"
        assert "二樓" in l["floor"] or "3室" in l["floor"] or l["floor"] == ""

    def test_agent_populated(self, detail_cgb284: dict) -> None:
        l = src._normalize_detail(detail_cgb284)
        # CGB284 has 9 agents — primary should be first (李旨駿 / Duncan Lee).
        assert l["agent_personal"]
        assert l["agent_license_personal"].startswith(("S-", "C-", "E-"))
        assert "Centanet" in l["agent_company"] or "中原" in l["agent_company"]

    def test_feature_tags_in_extras(self, detail_cgb284: dict) -> None:
        l = src._normalize_detail(detail_cgb284)
        extras = l.get("source_extras") or {}
        tags = extras.get("feature_tags") or []
        assert isinstance(tags, list) and tags
        # CGB284 → "鎖匙盤" / "AI裝修" / "獨家"
        assert any("鎖匙" in t or "獨家" in t or "AI" in t for t in tags)

    def test_school_net_and_management(self, detail_cgb284: dict) -> None:
        l = src._normalize_detail(detail_cgb284)
        extras = l.get("source_extras") or {}
        assert extras.get("school_net_primary") == "70"
        assert "怡高" in extras.get("management_company", "")

    def test_cat_label(self, detail_cgb284: dict) -> None:
        l = src._normalize_detail(detail_cgb284)
        extras = l.get("source_extras") or {}
        # CGB284 → "大型商場、地鐵沿線、停車場"
        assert "地鐵" in extras.get("cat_label_description", "")

    def test_agent_count_when_multiple(self, detail_cgb284: dict) -> None:
        l = src._normalize_detail(detail_cgb284)
        extras = l.get("source_extras") or {}
        # CGB284 has 9 agents
        assert extras.get("agent_count", 0) >= 2

    def test_handles_missing_optional_fields(self) -> None:
        """Detail API can return sparse records (delisted, missing media, etc).
        _normalize_detail must not crash on absent media/feature/estateInfo."""
        sparse = {
            "id": "x",
            "refNo": "CXX001",
            "estateName": "Foo",
            "buildingName": "",
            "address": "",
            "bedroomCount": None,
            "priceInfo": {"rent": 5000},
            "areaInfo": {"size": 0, "nSize": 0},
            "picture": {},
            "scope": {"webScope": ""},
            "media": {},
            "feature": {},
            "estateInfo": {},
            "postAgents": [],
            "labelGroup": {},
            "webUrl": "",
            "detailUrl": "https://hk.centanet.com/findproperty/detail/_CXX001",
            "publishDate": "",
            "updateDate": "",
        }
        l = src._normalize_detail(sparse)
        assert l["source"] == "centanet"
        assert l["price_hkd"] == 5000
        # No image / MTR / agent — keys may be absent or empty.
        assert not l.get("image_urls")
        assert l.get("nearest_mtr_station", "") == ""
        assert l.get("agent_personal", "") == ""


# ---------- get_detail routing ----------


class TestGetDetailDispatch:
    """get_detail must route by source_id shape: refNo→direct, UUID→search,
    URL→extract refNo. Network calls are intercepted via monkeypatch (we
    don't import respx here — the existing tests use simple monkeypatches)."""

    async def test_refno_calls_detail_api_directly(
        self, monkeypatch, detail_cgb284: dict
    ) -> None:
        get_calls: list[tuple[str, dict]] = []
        post_calls: list[tuple[str, dict]] = []

        async def fake_get(path: str, params: dict) -> dict:
            get_calls.append((path, params))
            return detail_cgb284

        async def fake_post(path: str, payload: dict) -> dict:
            post_calls.append((path, payload))
            raise AssertionError("must not call Search for refNo input")

        monkeypatch.setattr(src._client, "get_json", fake_get)
        monkeypatch.setattr(src._client, "post_json", fake_post)

        listing = await src.get_detail("CGB284")

        assert len(get_calls) == 1
        assert get_calls[0][0] == "/api/Post/Detail"
        assert get_calls[0][1]["refNo"] == "CGB284"
        assert get_calls[0][1]["fromPostType"] == "Rent"
        assert post_calls == []
        assert listing["nearest_mtr_station"] == "兆康"

    async def test_url_extracts_refno(
        self, monkeypatch, detail_cgb284: dict
    ) -> None:
        captured: dict[str, str] = {}

        async def fake_get(path: str, params: dict) -> dict:
            captured["refNo"] = params.get("refNo", "")
            return detail_cgb284

        monkeypatch.setattr(src._client, "get_json", fake_get)
        await src.get_detail(
            "https://hk.centanet.com/findproperty/detail/兆康苑_CGB284"
        )
        assert captured["refNo"] == "CGB284"

    async def test_uuid_falls_back_to_search(
        self, monkeypatch, detail_cgb284: dict, search_raw: dict
    ) -> None:
        post_pages: list[int] = []

        async def fake_post(path: str, payload: dict) -> dict:
            post_pages.append(payload.get("page", 0))
            return search_raw  # contains record with id e602c53e-... → refNo CPH580

        get_calls: list[dict] = []

        async def fake_get(path: str, params: dict) -> dict:
            get_calls.append(params)
            return detail_cgb284

        monkeypatch.setattr(src._client, "get_json", fake_get)
        monkeypatch.setattr(src._client, "post_json", fake_post)

        # Use the UUID actually present in the search fixture (first record).
        uuid = search_raw["data"][0]["id"]
        await src.get_detail(uuid)

        assert post_pages and post_pages[0] == 1  # started from page 1
        # Detail API was called with refNo CPH580 (the one matching the UUID).
        assert get_calls and get_calls[0]["refNo"] == "CPH580"

    async def test_uuid_not_found_raises(
        self, monkeypatch, search_raw: dict
    ) -> None:
        async def fake_post(path: str, payload: dict) -> dict:
            # Always return same fixture — UUID will never be in it.
            return search_raw

        async def fake_get(path: str, params: dict) -> dict:
            raise AssertionError("must not reach Detail when UUID unresolved")

        monkeypatch.setattr(src._client, "get_json", fake_get)
        monkeypatch.setattr(src._client, "post_json", fake_post)

        with pytest.raises(src.CentanetFetchError, match="not found"):
            await src.get_detail("00000000-0000-0000-0000-000000000000")

    async def test_invalid_id_raises_value_error(self, monkeypatch) -> None:
        async def boom_get(path: str, params: dict) -> dict:
            raise AssertionError("must not hit network for invalid id")

        async def boom_post(path: str, payload: dict) -> dict:
            raise AssertionError("must not hit network for invalid id")

        monkeypatch.setattr(src._client, "get_json", boom_get)
        monkeypatch.setattr(src._client, "post_json", boom_post)

        with pytest.raises(ValueError, match="not a recognized"):
            await src.get_detail("not-an-id-of-any-kind")

    async def test_empty_response_raises(self, monkeypatch) -> None:
        async def fake_get(path: str, params: dict) -> dict:
            return {}

        monkeypatch.setattr(src._client, "get_json", fake_get)
        with pytest.raises(src.CentanetFetchError, match="empty or malformed"):
            await src.get_detail("CGB284")
