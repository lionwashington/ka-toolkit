"""Tests for source="all" fan-out + dedupe logic (no network)."""

from __future__ import annotations

from hkprop_mcp.tools import _dedupe_listings, _richness


class TestRichness:
    def test_empty(self) -> None:
        assert _richness({}) == 0

    def test_one_field(self) -> None:
        assert _richness({"title": "x"}) == 1

    def test_skips_zero_and_empty(self) -> None:
        assert _richness({"title": "x", "price_hkd": 0, "image_urls": []}) == 1


class TestDedupe:
    def test_no_duplicates(self) -> None:
        items = [
            {"source": "a", "source_id": "1", "building": "X", "address": "Rd 1", "price_hkd": 10000},
            {"source": "b", "source_id": "2", "building": "Y", "address": "Rd 2", "price_hkd": 11000},
        ]
        out = _dedupe_listings(items)  # type: ignore[arg-type]
        assert len(out) == 2

    def test_same_property_two_sources_merged(self) -> None:
        a = {"source": "28hse", "source_id": "1", "building": "X", "address": "Rd 1",
             "price_hkd": 10000, "title": "Listing on 28Hse"}
        b = {"source": "centanet", "source_id": "z", "building": "X", "address": "Rd 1",
             "price_hkd": 10000, "title": "Listing on Centanet",
             "bedrooms": 2, "direction": "東南"}
        out = _dedupe_listings([a, b])  # type: ignore[arg-type]
        assert len(out) == 1
        # b is richer (more non-empty fields) → it should win
        assert out[0]["source"] == "centanet"
        extras = out[0].get("source_extras") or {}
        assert "28hse" in extras.get("also_listed_on", [])

    def test_empty_key_components_no_dedup(self) -> None:
        """Two listings both missing building+address+price should NOT collide."""
        a = {"source": "28hse", "source_id": "1"}
        b = {"source": "28hse", "source_id": "2"}
        out = _dedupe_listings([a, b])  # type: ignore[arg-type]
        assert len(out) == 2

    def test_case_insensitive_match(self) -> None:
        a = {"source": "a", "source_id": "1", "building": "Novo Land", "address": "Yan Po Rd", "price_hkd": 10000}
        b = {"source": "b", "source_id": "2", "building": "NOVO LAND", "address": "YAN PO RD", "price_hkd": 10000}
        out = _dedupe_listings([a, b])  # type: ignore[arg-type]
        assert len(out) == 1
