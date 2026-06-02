"""Commute module tests — fixture-based, no network.

Covers:
    - API key resolution (env → secrets.yaml → error)
    - departure-time parsing (None → next weekday 8am, "now", ISO 8601)
    - origin-from-listing (geo path, address fallback, error)
    - directions response normalization
    - ZERO_RESULTS error
"""

from __future__ import annotations

import json
import pathlib
from datetime import datetime, timedelta

import pytest

from hkprop_mcp import commute


FIXTURES = pathlib.Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def sample_directions() -> dict:
    return json.loads(
        (FIXTURES / "google-directions-transit-sample.json").read_text()
    )


# ---------- _load_api_key ----------


class TestLoadApiKey:
    def test_env_var_wins(self, monkeypatch, tmp_path):
        monkeypatch.setenv("GOOGLE_MAPS_API_KEY", "env_AIza_xyz")
        # Point secrets to a tmp file that ALSO contains a key — env wins.
        secrets = tmp_path / "secrets.yaml"
        secrets.write_text("google_maps_api_key: file_AIza_abc\n")
        monkeypatch.setenv("KA_SECRETS_PATH", str(secrets))
        assert commute._load_api_key() == "env_AIza_xyz"

    def test_secrets_file_fallback(self, monkeypatch, tmp_path):
        monkeypatch.delenv("GOOGLE_MAPS_API_KEY", raising=False)
        secrets = tmp_path / "secrets.yaml"
        secrets.write_text(
            "# comment line\n"
            "amap_api_key: ignored\n"
            "google_maps_api_key: file_AIza_abc\n"
            "other: stuff\n"
        )
        monkeypatch.setenv("KA_SECRETS_PATH", str(secrets))
        assert commute._load_api_key() == "file_AIza_abc"

    def test_secrets_file_quoted_value(self, monkeypatch, tmp_path):
        monkeypatch.delenv("GOOGLE_MAPS_API_KEY", raising=False)
        secrets = tmp_path / "secrets.yaml"
        secrets.write_text('google_maps_api_key: "quoted_AIza_123"\n')
        monkeypatch.setenv("KA_SECRETS_PATH", str(secrets))
        assert commute._load_api_key() == "quoted_AIza_123"

    def test_missing_file(self, monkeypatch, tmp_path):
        monkeypatch.delenv("GOOGLE_MAPS_API_KEY", raising=False)
        monkeypatch.setenv("KA_SECRETS_PATH", str(tmp_path / "missing.yaml"))
        with pytest.raises(commute.CommuteError, match="not found"):
            commute._load_api_key()

    def test_file_without_key(self, monkeypatch, tmp_path):
        monkeypatch.delenv("GOOGLE_MAPS_API_KEY", raising=False)
        secrets = tmp_path / "secrets.yaml"
        secrets.write_text("amap_api_key: only_amap\n")
        monkeypatch.setenv("KA_SECRETS_PATH", str(secrets))
        with pytest.raises(commute.CommuteError, match="not found in"):
            commute._load_api_key()


# ---------- _next_weekday_8am ----------


class TestNextWeekday8am:
    def test_friday_evening_jumps_to_monday(self):
        # Friday 2026-05-29 18:00 HKT → next weekday 8am = Monday 2026-06-01 08:00.
        friday_evening = datetime(2026, 5, 29, 18, 0, tzinfo=commute.HK_TZ)
        nxt = commute._next_weekday_8am(now=friday_evening)
        assert nxt.weekday() == 0  # Monday
        assert nxt.hour == 8
        assert nxt.date() == friday_evening.date() + timedelta(days=3)

    def test_saturday_jumps_to_monday(self):
        sat = datetime(2026, 5, 30, 10, 0, tzinfo=commute.HK_TZ)
        nxt = commute._next_weekday_8am(now=sat)
        assert nxt.weekday() == 0
        assert nxt.date() == sat.date() + timedelta(days=2)

    def test_tuesday_morning_after_8am_jumps_to_wednesday(self):
        tue = datetime(2026, 5, 26, 9, 30, tzinfo=commute.HK_TZ)
        nxt = commute._next_weekday_8am(now=tue)
        assert nxt.date() == tue.date() + timedelta(days=1)
        assert nxt.hour == 8

    def test_monday_before_8am_uses_today(self):
        mon = datetime(2026, 6, 1, 6, 0, tzinfo=commute.HK_TZ)
        nxt = commute._next_weekday_8am(now=mon)
        assert nxt.date() == mon.date()
        assert nxt.hour == 8


# ---------- _parse_departure ----------


class TestParseDeparture:
    def test_none_returns_future_timestamp(self):
        ts = commute._parse_departure(None)
        assert ts > int(datetime.now(commute.HK_TZ).timestamp())

    def test_now_returns_current(self):
        before = int(datetime.now(commute.HK_TZ).timestamp())
        ts = commute._parse_departure("now")
        after = int(datetime.now(commute.HK_TZ).timestamp())
        assert before <= ts <= after + 1

    def test_iso_with_tz(self):
        ts = commute._parse_departure("2026-06-01T08:00:00+08:00")
        # 2026-06-01 08:00 HKT = 2026-06-01 00:00 UTC = 1780012800
        expected = int(datetime(2026, 6, 1, 8, 0, tzinfo=commute.HK_TZ).timestamp())
        assert ts == expected

    def test_iso_naive_assumes_hkt(self):
        ts = commute._parse_departure("2026-06-01T08:00:00")
        expected = int(datetime(2026, 6, 1, 8, 0, tzinfo=commute.HK_TZ).timestamp())
        assert ts == expected

    def test_iso_with_z_suffix(self):
        ts = commute._parse_departure("2026-06-01T00:00:00Z")
        # 2026-06-01 00:00 UTC
        from datetime import timezone
        expected = int(datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc).timestamp())
        assert ts == expected


# ---------- origin_from_listing ----------


class TestOriginFromListing:
    def test_geo_coords_preferred(self):
        listing = {
            "geo_lat": 22.385,
            "geo_lon": 113.96,
            "building": "麗虹花園 1座",
            "address": "丹桂村路1號",
        }
        assert commute.origin_from_listing(listing) == "22.385,113.96"

    def test_address_fallback_no_geo(self):
        listing = {
            "geo_lat": None,
            "geo_lon": None,
            "building": "麗虹花園 1座",
            "address": "丹桂村路1號",
        }
        assert commute.origin_from_listing(listing) == (
            "麗虹花園 1座, 丹桂村路1號, Hong Kong"
        )

    def test_only_building(self):
        listing = {"building": "Novo Land Elverum", "address": ""}
        assert commute.origin_from_listing(listing) == (
            "Novo Land Elverum, Hong Kong"
        )

    def test_empty_listing_raises(self):
        with pytest.raises(commute.CommuteError, match="Cannot compute commute"):
            commute.origin_from_listing({"source": "28hse", "source_id": "999"})


# ---------- summarize_directions ----------


class TestSummarizeDirections:
    def test_basic_normalization(self, sample_directions):
        r = commute.summarize_directions(sample_directions)
        assert r["total_minutes"] == 45
        assert r["walking_minutes"] == 12  # 5 + 7
        assert r["transit_minutes"] == 20
        assert r["transfers"] == 0  # single transit segment = 0 transfers
        assert r["fare_hkd"] == 12.5
        assert r["fare_currency"] == "HKD"
        assert r["departure_time"] == "上午8:00"
        assert r["arrival_time"] == "上午8:45"

    def test_origin_destination(self, sample_directions):
        r = commute.summarize_directions(sample_directions)
        assert r["origin"]["lat"] == 22.385
        assert r["origin"]["lng"] == 113.96
        assert "麗虹花園" in r["origin"]["address"]
        assert "維多利亞港" in r["destination"]["address"]

    def test_steps_have_required_fields(self, sample_directions):
        r = commute.summarize_directions(sample_directions)
        steps = r["steps"]
        assert len(steps) == 3
        assert steps[0]["mode"] == "WALKING"
        assert steps[0]["duration_min"] == 5
        # Transit step has line + from/to
        assert steps[1]["mode"] == "TRANSIT"
        assert steps[1]["line"] == "961"
        assert steps[1]["vehicle"] == "BUS"
        assert steps[1]["from"] == "麗虹花園"
        assert steps[1]["to"] == "尖沙咀碼頭 (維多利亞港)"
        assert steps[1]["num_stops"] == 8
        assert steps[2]["mode"] == "WALKING"
        assert steps[2]["duration_min"] == 7

    def test_two_transit_segments_counts_one_transfer(self, sample_directions):
        # Duplicate the transit step → 2 transit segments = 1 transfer.
        raw = json.loads(json.dumps(sample_directions))
        leg = raw["routes"][0]["legs"][0]
        transit_step = leg["steps"][1]
        leg["steps"].insert(2, json.loads(json.dumps(transit_step)))
        r = commute.summarize_directions(raw)
        assert r["transfers"] == 1

    def test_zero_results_raises(self):
        with pytest.raises(commute.CommuteError, match="no transit routes"):
            commute.summarize_directions({"status": "ZERO_RESULTS", "routes": []})

    def test_empty_routes_raises(self):
        with pytest.raises(commute.CommuteError, match="empty routes"):
            commute.summarize_directions({"status": "OK", "routes": []})

    def test_no_fare_returns_none(self, sample_directions):
        raw = json.loads(json.dumps(sample_directions))
        raw["routes"][0].pop("fare")
        r = commute.summarize_directions(raw)
        assert r["fare_hkd"] is None
        assert r["fare_currency"] == ""

    def test_non_hkd_fare_returns_none(self, sample_directions):
        raw = json.loads(json.dumps(sample_directions))
        raw["routes"][0]["fare"] = {"currency": "USD", "value": 1.5}
        r = commute.summarize_directions(raw)
        assert r["fare_hkd"] is None
        assert r["fare_currency"] == "USD"
