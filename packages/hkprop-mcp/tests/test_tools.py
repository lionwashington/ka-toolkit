"""Dispatcher tests (no network).

The tools layer is source-agnostic. These tests verify it correctly resolves
districts and source names; the actual fetch+parse logic lives in source
modules and is tested separately.
"""

from __future__ import annotations

import pytest

from hkprop_mcp import commute as commute_mod
from hkprop_mcp import sources, tools
from hkprop_mcp.tools import _resolve_district


class TestResolveDistrict:
    def test_none_means_all_hk(self) -> None:
        assert _resolve_district(None) is None

    def test_empty_string_means_all_hk(self) -> None:
        assert _resolve_district("") is None
        assert _resolve_district("   ") is None

    def test_code_passes_through(self) -> None:
        assert _resolve_district("dg48") == "dg48"

    def test_english_name_resolves(self) -> None:
        assert _resolve_district("Tuen Mun") == "dg48"
        assert _resolve_district("tuen mun") == "dg48"

    def test_chinese_name_resolves(self) -> None:
        assert _resolve_district("屯門") == "dg48"

    def test_unknown_raises(self) -> None:
        with pytest.raises(ValueError, match="not recognized"):
            _resolve_district("Atlantis")


class TestSourceRegistry:
    def test_28hse_registered(self) -> None:
        impl = sources.get("28hse")
        assert impl.name == "28hse"
        assert "28Hse" in impl.display_name

    def test_unknown_source_raises(self) -> None:
        with pytest.raises(ValueError, match="Unknown source"):
            sources.get("zillow")

    def test_default_source_is_28hse(self) -> None:
        assert sources.DEFAULT_SOURCE == "28hse"

    def test_list_sources_shape(self) -> None:
        lst = sources.list_sources()
        assert isinstance(lst, list)
        assert all("name" in s and "display_name" in s for s in lst)
        assert any(s["name"] == "28hse" for s in lst)


class TestCommuteToSchoolDispatch:
    """Verify the two property_id input paths for commute_to_school.

    The Google Directions HTTP call is stubbed via monkeypatch so we test
    only the dispatcher's listing-resolution branch logic.
    """

    @pytest.fixture
    def fake_directions(self) -> dict:
        # Minimal Directions response that summarize_directions accepts.
        return {
            "status": "OK",
            "routes": [{
                "legs": [{
                    "duration": {"value": 1800},
                    "departure_time": {"text": "上午8:00"},
                    "arrival_time": {"text": "上午8:30"},
                    "start_location": {"lat": 22.385, "lng": 113.96},
                    "end_location": {"lat": 22.378, "lng": 113.973},
                    "start_address": "丹桂村路1號, 香港",
                    "end_address": "維多利亞港, 尖沙咀, 香港",
                    "steps": [
                        {"travel_mode": "WALKING",
                         "duration": {"value": 300},
                         "html_instructions": "步行"},
                        {"travel_mode": "TRANSIT",
                         "duration": {"value": 1200},
                         "html_instructions": "搭巴士",
                         "transit_details": {
                             "line": {
                                 "short_name": "961",
                                 "vehicle": {"type": "BUS"},
                             },
                             "departure_stop": {"name": "麗虹花園"},
                             "arrival_stop": {"name": "維多利亞港"},
                             "num_stops": 6,
                         }},
                        {"travel_mode": "WALKING",
                         "duration": {"value": 300},
                         "html_instructions": "步行"},
                    ],
                }],
                "fare": {"currency": "HKD", "value": 7.8},
            }],
        }

    async def test_dict_skips_lookup(self, monkeypatch, fake_directions) -> None:
        """Passing a Listing dict bypasses get_detail entirely.

        This is the path that unblocks the Centanet "not found in first 50
        results" bug — caller has the listing in hand from a narrow search.
        """
        listing = {
            "source": "centanet",
            "source_id": "CGB284",
            "building": "兆康苑 兆欣閣",
            "address": "兆康苑兆康路1號",
            "url": "https://hk.centanet.com/findproperty/CGB284",
            "price_hkd": 11800,
        }

        async def fake_directions_call(origin, destination, departure_time=None):
            assert "兆康苑" in origin
            assert "Victoria Harbour" in destination
            return fake_directions

        # If the dispatcher tried to look up the listing it would hit Centanet's
        # search API — failing the test loudly via this monkeypatched sentinel.
        async def boom(_id):
            raise AssertionError("get_detail must not be called when dict supplied")

        monkeypatch.setattr(commute_mod, "directions_transit", fake_directions_call)
        monkeypatch.setattr(sources.SOURCES["centanet"], "get_detail", boom)

        result = await tools.commute_to_school(listing, source="centanet")

        assert result["total_minutes"] == 30
        assert result["listing"]["source"] == "centanet"
        assert result["listing"]["source_id"] == "CGB284"
        assert result["listing"]["building"] == "兆康苑 兆欣閣"
        assert result["listing"]["price_hkd"] == 11800

    async def test_str_id_triggers_lookup(self, monkeypatch, fake_directions) -> None:
        """Passing an id string still calls the source's get_detail (legacy path)."""
        calls = []

        async def fake_get_detail(source_id):
            calls.append(source_id)
            return {
                "source": "28hse",
                "source_id": source_id,
                "building": "Novo Land Elverum",
                "address": "屯門菁田路1號",
                "geo_lat": 22.3925,
                "geo_lon": 113.9685,
            }

        async def fake_directions_call(origin, destination, departure_time=None):
            return fake_directions

        monkeypatch.setattr(commute_mod, "directions_transit", fake_directions_call)
        monkeypatch.setattr(sources.SOURCES["28hse"], "get_detail", fake_get_detail)

        result = await tools.commute_to_school("3860784", source="28hse")

        assert calls == ["3860784"]
        assert result["listing"]["source_id"] == "3860784"
        assert result["listing"]["building"] == "Novo Land Elverum"


class TestGetListingDetailDispatch:
    """get_listing_detail's dict-path is the V3.2 fix: caller already has a
    listing from search_listings and we should avoid re-querying or — for
    Centanet — sidestep the UUID-lookup penalty by reading source_extras.refNo."""

    async def test_str_passes_through(self, monkeypatch) -> None:
        seen: list[str] = []

        async def fake_get_detail(sid):
            seen.append(sid)
            return {"source": "28hse", "source_id": sid, "building": "X"}

        monkeypatch.setattr(sources.SOURCES["28hse"], "get_detail", fake_get_detail)
        out = await tools.get_listing_detail("3860784", source="28hse")
        assert seen == ["3860784"]
        assert out["building"] == "X"

    async def test_centanet_dict_prefers_refno_over_uuid(self, monkeypatch) -> None:
        """A search-derived Centanet dict carries source_id=UUID + source_extras.refNo.
        get_detail must be called with the refNo, NOT the UUID — otherwise we
        pay the 5-page Search scan that this fix exists to avoid."""
        seen: list[str] = []

        async def fake_get_detail(sid):
            seen.append(sid)
            return {"source": "centanet", "source_id": sid}

        monkeypatch.setattr(sources.SOURCES["centanet"], "get_detail", fake_get_detail)

        listing_from_search = {
            "source": "centanet",
            "source_id": "e602c53e-6010-cd24-139a-08de06ff6b08",
            "building": "麗虹花園 1座",
            "source_extras": {"refNo": "CPH580"},
        }
        await tools.get_listing_detail(listing_from_search)
        assert seen == ["CPH580"]

    async def test_dict_source_overrides_kwarg(self, monkeypatch) -> None:
        """The dict's own ``source`` wins — the kwarg is a default for str input."""
        called_on: list[str] = []

        async def fake_28(_sid):
            called_on.append("28hse")
            return {"source": "28hse"}

        async def fake_cn(_sid):
            called_on.append("centanet")
            return {"source": "centanet"}

        monkeypatch.setattr(sources.SOURCES["28hse"], "get_detail", fake_28)
        monkeypatch.setattr(sources.SOURCES["centanet"], "get_detail", fake_cn)

        listing = {
            "source": "centanet",
            "source_id": "CGB284",
            "source_extras": {"refNo": "CGB284"},
        }
        await tools.get_listing_detail(listing, source="28hse")  # wrong kwarg
        assert called_on == ["centanet"]

    async def test_centanet_dict_without_refno_falls_back_to_source_id(
        self, monkeypatch
    ) -> None:
        """If a Centanet dict lacks source_extras.refNo (e.g. older cache),
        source_id is passed through — get_detail handles UUID via its own
        fallback."""
        seen: list[str] = []

        async def fake_get_detail(sid):
            seen.append(sid)
            return {"source": "centanet"}

        monkeypatch.setattr(sources.SOURCES["centanet"], "get_detail", fake_get_detail)
        await tools.get_listing_detail(
            {"source": "centanet", "source_id": "CGB284"}
        )
        assert seen == ["CGB284"]

    async def test_dict_missing_id_raises(self) -> None:
        with pytest.raises(ValueError, match="no usable identifier"):
            await tools.get_listing_detail({"source": "centanet"})
