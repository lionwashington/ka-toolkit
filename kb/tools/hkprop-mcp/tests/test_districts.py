"""Tests for district lookup table."""

from __future__ import annotations

import pytest

from hkprop_mcp.districts import (
    DISTRICTS,
    PROPERTY_TYPES,
    REGIONS,
    find_district,
    list_all,
)


def test_tuen_mun_present() -> None:
    """Tuen Mun (dg48) is the primary target area — must exist."""
    assert "dg48" in DISTRICTS
    region, en, zh = DISTRICTS["dg48"]
    assert region == "a3"
    assert en == "Tuen Mun"
    assert zh == "屯門"


def test_find_district_by_english_name() -> None:
    found = find_district("Tuen Mun")
    assert found is not None
    code, en, zh = found
    assert code == "dg48"
    assert en == "Tuen Mun"
    assert zh == "屯門"


def test_find_district_by_chinese_name() -> None:
    found = find_district("屯門")
    assert found is not None
    code, _, _ = found
    assert code == "dg48"


def test_find_district_case_insensitive() -> None:
    assert find_district("tuen mun") is not None
    assert find_district("TUEN MUN") is not None


def test_find_district_substring_match() -> None:
    found = find_district("yuen")  # partial match → Yuen Long
    assert found is not None
    code, en, _ = found
    assert code == "dg47"
    assert en == "Yuen Long"


def test_find_district_returns_none_for_unknown() -> None:
    assert find_district("Atlantis") is None
    assert find_district("") is None


def test_lion_target_districts_all_exist() -> None:
    """The 4 target districts for the 2026/9 HK move."""
    for code, en in [
        ("dg48", "Tuen Mun"),
        ("dg47", "Yuen Long"),
        ("dg49", "Tin Shui Wai"),
        ("dg44", "Tsuen Wan"),
    ]:
        assert code in DISTRICTS
        assert DISTRICTS[code][1] == en


def test_regions_complete() -> None:
    """All 4 HK regions are present."""
    assert set(REGIONS.keys()) == {"a1", "a2", "a3", "a4"}


def test_property_types_include_apartment() -> None:
    assert "apartment" in PROPERTY_TYPES


def test_list_all_returns_full_table() -> None:
    rows = list_all()
    assert len(rows) == len(DISTRICTS)
    for row in rows:
        assert {"code", "region_code", "region_en", "region_zh",
                "name_en", "name_zh"} <= row.keys()


def test_every_district_has_valid_region() -> None:
    for code, (region, _en, _zh) in DISTRICTS.items():
        assert region in REGIONS, f"{code} has invalid region {region!r}"
