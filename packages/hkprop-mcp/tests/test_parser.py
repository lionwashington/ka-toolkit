"""Parser tests against captured 28Hse HTML fixtures.

These tests don't touch the network. If 28Hse changes its HTML structure,
update the fixtures and adjust the parser. The fixtures live in
``tests/fixtures/`` and are intentionally committed so tests are reproducible.
"""

from __future__ import annotations

import os
import pathlib

import pytest

from hkprop_mcp.parser import (
    parse_listing_detail,
    parse_search_results,
    parse_transportation_items,
    pick_nearest_mtr,
)


FIXTURES = pathlib.Path(__file__).parent / "fixtures"


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def search_html() -> str:
    return _read("search-tuenmun-rent.html")


@pytest.fixture(scope="module")
def detail_html() -> str:
    return _read("detail-3860784.html")


class TestSearchResults:
    def test_total_count(self, search_html: str) -> None:
        parsed = parse_search_results(search_html)
        # 28Hse showed 638 results for Tuen Mun rent when the fixture was captured.
        # Allow some drift since fixtures may be re-captured; just sanity check.
        assert parsed["total"] is not None
        assert parsed["total"] > 100

    def test_returns_15_listings(self, search_html: str) -> None:
        parsed = parse_search_results(search_html)
        assert len(parsed["results"]) == 15

    def test_first_listing_fields(self, search_html: str) -> None:
        first = parse_search_results(search_html)["results"][0]
        assert first["property_id"] == 3860784
        assert "/property-3860784" in first["url"]
        assert first["district"] == "Tuen Mun"
        assert first["building"] == "Novo Land"
        assert first["saleable_ft"] == 242
        assert first["price_hkd"] == 10500
        assert first["agent_company"] == "Midland Realty"
        assert first["photo_count"] == 9
        assert first["property_type"] == "apartment"

    def test_all_listings_have_id(self, search_html: str) -> None:
        for r in parse_search_results(search_html)["results"]:
            assert r["property_id"] is not None
            assert r["url"].startswith("https://")


class TestListingDetail:
    def test_core_identity(self, detail_html: str) -> None:
        d = parse_listing_detail(detail_html)
        assert d["property_id"] == 3860784
        assert "property-3860784" in d["url"]

    def test_address_and_geo(self, detail_html: str) -> None:
        d = parse_listing_detail(detail_html)
        assert "Yan Po Road" in d["address"]
        assert d["geo_lat"] == 22.412807
        assert d["geo_lon"] == 113.971634

    def test_building_and_district(self, detail_html: str) -> None:
        d = parse_listing_detail(detail_html)
        assert d["building"] == "Novo Land"
        assert d["district"] == "Tuen Mun"

    def test_price_and_area(self, detail_html: str) -> None:
        d = parse_listing_detail(detail_html)
        assert d["price_hkd"] == 10500
        assert d["currency"] == "HKD"
        assert d["saleable_ft"] == 242

    def test_rooms(self, detail_html: str) -> None:
        d = parse_listing_detail(detail_html)
        assert d["bedrooms"] == 1
        assert d["bathrooms"] == 1

    def test_floor_description(self, detail_html: str) -> None:
        d = parse_listing_detail(detail_html)
        assert "Floor" in d["floor"]
        assert "/F" in d["floor"]

    def test_furnished_status(self, detail_html: str) -> None:
        d = parse_listing_detail(detail_html)
        assert d["furnished"] == "Partially Furnished"

    def test_agent_company(self, detail_html: str) -> None:
        d = parse_listing_detail(detail_html)
        assert d["agent_company"] == "Midland Realty"

    def test_agent_personal_excludes_company(self, detail_html: str) -> None:
        d = parse_listing_detail(detail_html)
        # The personal agent name must not be the company name.
        assert d["agent_personal"] != d["agent_company"]
        # Should contain a real name (not empty)
        assert d["agent_personal"]

    def test_license_numbers(self, detail_html: str) -> None:
        d = parse_listing_detail(detail_html)
        assert d["agent_license_personal"].startswith(("S-", "C-"))
        assert d["agent_license_company"].startswith(("S-", "C-"))

    def test_image_urls(self, detail_html: str) -> None:
        d = parse_listing_detail(detail_html)
        assert len(d["image_urls"]) >= 1
        assert all(url.startswith("http") for url in d["image_urls"])

    def test_dates(self, detail_html: str) -> None:
        d = parse_listing_detail(detail_html)
        assert d["date_published"]
        assert d["date_modified"]

    def test_transport_items_extracted(self, detail_html: str) -> None:
        """The 'Trans' section under 'Nearby' lists bus stops / MTR / etc. We
        extract every row with name + parenthetical type + walk minutes."""
        d = parse_listing_detail(detail_html)
        items = d["transport_items"]
        assert isinstance(items, list)
        assert items, "expected at least one transport row in detail HTML"
        # Novo Land fixture has Bus Stops only (no MTR nearby).
        bus_stops = [i for i in items if "Bus Stop" in (i.get("type") or "")]
        assert bus_stops
        # Each entry has name + walk_minutes int.
        for i in items:
            assert i["name"]
            if i["walk_minutes"] is not None:
                assert isinstance(i["walk_minutes"], int)
                assert i["walk_minutes"] >= 0

    def test_nearest_mtr_none_when_only_buses(self, detail_html: str) -> None:
        """Novo Land has no nearby MTR — the field should be empty, not faked."""
        d = parse_listing_detail(detail_html)
        # Novo Land (Tuen Mun, bus-zone) — no MTR nearby in fixture.
        assert d["nearest_mtr_station"] == ""
        assert d["walk_to_mtr_minutes"] is None


class TestTransportationParser:
    """Unit-level tests for the new transport extractors — small HTML snippets."""

    def test_pick_nearest_mtr_picks_smallest_walk(self) -> None:
        items = [
            {"name": "Tin Hau", "type": "MTR", "walk_minutes": 8},
            {"name": "Causeway Bay", "type": "MTR", "walk_minutes": 3},
            {"name": "Tin Hau Bus Terminus", "type": "Bus Stop", "walk_minutes": 1},
        ]
        nearest = pick_nearest_mtr(items)
        assert nearest is not None
        assert nearest["name"] == "Causeway Bay"
        assert nearest["walk_minutes"] == 3

    def test_pick_nearest_mtr_returns_none_when_no_rail(self) -> None:
        items = [
            {"name": "X Stop", "type": "Bus Stop", "walk_minutes": 2},
            {"name": "Y Mall", "type": "Mall", "walk_minutes": 5},
        ]
        assert pick_nearest_mtr(items) is None

    def test_pick_nearest_recognizes_chinese_rail_tokens(self) -> None:
        items = [
            {"name": "兆康", "type": "西鐵", "walk_minutes": 1},
            {"name": "屯門", "type": "輕鐵", "walk_minutes": 5},
        ]
        nearest = pick_nearest_mtr(items)
        assert nearest and nearest["name"] == "兆康"

    def test_unknown_walk_min_sorts_last(self) -> None:
        items = [
            {"name": "A", "type": "MTR", "walk_minutes": None},
            {"name": "B", "type": "MTR", "walk_minutes": 7},
        ]
        nearest = pick_nearest_mtr(items)
        assert nearest and nearest["name"] == "B"

    def test_parse_transportation_items_handles_empty_html(self) -> None:
        assert parse_transportation_items("<html><body></body></html>") == []
