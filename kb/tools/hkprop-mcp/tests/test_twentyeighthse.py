"""28Hse source-specific tests: URL building, query params, normalization."""

from __future__ import annotations

import pytest

from hkprop_mcp.sources import twentyeighthse as src


class TestBuildSearchURL:
    def test_no_district_returns_all_hk(self) -> None:
        """district=None must yield the HK-wide search URL (no region/dg segments)."""
        assert src._build_search_url(None, "apartment", 1) == "/en/rent/apartment"

    def test_no_district_page_2(self) -> None:
        assert src._build_search_url(None, "apartment", 2) == "/en/rent/apartment/page-2"

    def test_no_district_any_type(self) -> None:
        """district=None + type='any' should give the broadest URL."""
        assert src._build_search_url(None, "any", 1) == "/en/rent"

    def test_tuen_mun_apartment_page_1(self) -> None:
        assert src._build_search_url("dg48", "apartment", 1) == "/en/rent/apartment/a3/dg48"

    def test_tuen_mun_apartment_page_2(self) -> None:
        assert src._build_search_url("dg48", "apartment", 2) == "/en/rent/apartment/a3/dg48/page-2"

    def test_yuen_long(self) -> None:
        assert src._build_search_url("dg47", "apartment", 1) == "/en/rent/apartment/a3/dg47"

    def test_district_any_type(self) -> None:
        assert src._build_search_url("dg48", "any", 1) == "/en/rent/a3/dg48"

    def test_village_type(self) -> None:
        assert src._build_search_url("dg48", "village", 1) == "/en/rent/village/a3/dg48"

    def test_unknown_district_raises(self) -> None:
        with pytest.raises(ValueError, match="Unknown district"):
            src._build_search_url("dg9999", "apartment", 1)


class TestBuildQueryParams:
    def test_empty(self) -> None:
        assert src._build_query_params(None, None, None, None, None) == {}

    def test_price_range(self) -> None:
        assert src._build_query_params(10000, 15000, None, None, None) == {
            "rent_from": 10000,
            "rent_to": 15000,
        }

    def test_rooms_and_size(self) -> None:
        assert src._build_query_params(None, None, 2, 300, 500) == {
            "room": 2,
            "size_from": 300,
            "size_to": 500,
        }

    def test_all_filters(self) -> None:
        params = src._build_query_params(10000, 15000, 2, 300, 500)
        assert params == {
            "rent_from": 10000,
            "rent_to": 15000,
            "room": 2,
            "size_from": 300,
            "size_to": 500,
        }

    def test_coerces_str_to_int(self) -> None:
        params = src._build_query_params("10000", "15000", "2", "300", "500")  # type: ignore[arg-type]
        assert all(isinstance(v, int) for v in params.values())


class TestNormalizeListing:
    """Verify the 28Hse parser output → normalized Listing mapping."""

    def test_minimal_fields(self) -> None:
        raw = {"property_id": 12345, "url": "https://x", "price_hkd": 10000}
        out = src._normalize_listing(raw)
        assert out["source"] == "28hse"
        assert out["source_id"] == "12345"
        assert out["url"] == "https://x"
        assert out["price_hkd"] == 10000
        assert out["currency"] == "HKD"

    def test_district_resolution_from_name(self) -> None:
        """The parser returns ``district="Tuen Mun"``; normalizer fills in
        district_code and Chinese name from our lookup."""
        raw = {"property_id": 1, "district": "Tuen Mun"}
        out = src._normalize_listing(raw)
        assert out["district_code"] == "dg48"
        assert out["district_name_en"] == "Tuen Mun"
        assert out["district_name_zh"] == "屯門"
        assert out["region_code"] == "a3"

    def test_unknown_district_leaves_code_empty(self) -> None:
        raw = {"property_id": 1, "district": "SomewhereElse"}
        out = src._normalize_listing(raw)
        assert out["district_code"] == ""
        # district_name_en falls back to raw input
        assert out["district_name_en"] == "SomewhereElse"

    def test_source_extras_collected(self) -> None:
        raw = {
            "property_id": 1,
            "grade": "Golden",
            "posted_text": "1 day ago",
            "unit_desc": "Unit A, 12/F",
        }
        out = src._normalize_listing(raw)
        assert out["source_extras"]["grade"] == "Golden"
        assert out["source_extras"]["unit_desc"] == "Unit A, 12/F"

    def test_no_source_extras_when_empty(self) -> None:
        raw = {"property_id": 1, "price_hkd": 5000}
        out = src._normalize_listing(raw)
        assert "source_extras" not in out

    def test_image_urls_default_to_empty_list(self) -> None:
        raw = {"property_id": 1}
        out = src._normalize_listing(raw)
        assert out["image_urls"] == []
