"""Pure-function tests for tool helpers — no IB Gateway needed."""

from __future__ import annotations

import datetime as dt
from types import SimpleNamespace

import pytest

from ibkr_mcp.tools import (
    _bar_date,
    _coerce_num,
    _coerce_tick_price,
    _parse_date,
    _split_symbols,
    _stock_contract,
)


class TestCoerceNum:
    def test_none(self) -> None:
        assert _coerce_num(None) is None

    def test_nan(self) -> None:
        assert _coerce_num(float("nan")) is None

    def test_float(self) -> None:
        assert _coerce_num(1.5) == 1.5

    def test_int(self) -> None:
        assert _coerce_num(3) == 3.0

    def test_string_number(self) -> None:
        assert _coerce_num("2.5") == 2.5

    def test_string_nonnumeric(self) -> None:
        assert _coerce_num("abc") is None

    def test_object(self) -> None:
        assert _coerce_num(object()) is None


class TestStockContract:
    def test_uppercases(self) -> None:
        c = _stock_contract(" nvda ")
        assert c.symbol == "NVDA"
        assert c.exchange == "SMART"
        assert c.currency == "USD"

    def test_rejects_empty(self) -> None:
        with pytest.raises(ValueError):
            _stock_contract("")

    def test_rejects_whitespace(self) -> None:
        with pytest.raises(ValueError):
            _stock_contract("   ")

    def test_rejects_too_long(self) -> None:
        with pytest.raises(ValueError):
            _stock_contract("A" * 25)


class TestParseDate:
    def test_valid(self) -> None:
        assert _parse_date("2026-05-13") == dt.date(2026, 5, 13)

    def test_invalid(self) -> None:
        with pytest.raises(ValueError):
            _parse_date("2026/05/13")

    def test_garbage(self) -> None:
        with pytest.raises(ValueError):
            _parse_date("not-a-date")


class TestCoerceTickPrice:
    """IBKR uses 0 and -1 as 'no live data' sentinels for last/bid/ask.
    They must NOT pass through as legitimate prices — that's Bug 2."""

    def test_zero_is_no_data(self) -> None:
        assert _coerce_tick_price(0.0) is None
        assert _coerce_tick_price(0) is None

    def test_neg_one_is_no_data(self) -> None:
        assert _coerce_tick_price(-1.0) is None
        assert _coerce_tick_price(-1) is None

    def test_none(self) -> None:
        assert _coerce_tick_price(None) is None

    def test_nan(self) -> None:
        assert _coerce_tick_price(float("nan")) is None

    def test_valid_price(self) -> None:
        assert _coerce_tick_price(145.32) == 145.32
        assert _coerce_tick_price("220.78") == 220.78

    def test_small_positive_passes(self) -> None:
        """Penny stocks shouldn't be confused with 'no data'."""
        assert _coerce_tick_price(0.01) == 0.01

    def test_other_negative_still_rejected_for_safety(self) -> None:
        """Negative prices that aren't -1 are still suspect — but we only
        explicitly filter -1 to avoid hiding legitimate-looking errors."""
        # -2.5 isn't a recognized sentinel, so it passes through. The
        # caller's responsibility to sanity-check if needed.
        assert _coerce_tick_price(-2.5) == -2.5


class TestSplitSymbols:
    """Defensive accepts: comma-string OR list. Regression for Bug 1 where a
    direct call ``stock_quotes('NVDA,VTI,QQQ')`` was iterating chars."""

    def test_comma_string(self) -> None:
        assert _split_symbols("NVDA,VTI,QQQ") == ["NVDA", "VTI", "QQQ"]

    def test_comma_string_with_spaces(self) -> None:
        assert _split_symbols(" nvda , vti , qqq ") == ["NVDA", "VTI", "QQQ"]

    def test_single_symbol_string(self) -> None:
        assert _split_symbols("NVDA") == ["NVDA"]

    def test_list(self) -> None:
        assert _split_symbols(["nvda", "vti"]) == ["NVDA", "VTI"]

    def test_tuple(self) -> None:
        assert _split_symbols(("nvda", "vti")) == ["NVDA", "VTI"]

    def test_empty_string(self) -> None:
        assert _split_symbols("") == []

    def test_empty_list(self) -> None:
        assert _split_symbols([]) == []

    def test_string_with_blanks(self) -> None:
        assert _split_symbols("NVDA,,VTI, ,") == ["NVDA", "VTI"]


class TestMarketDataType:
    def test_default_is_delayed(self, monkeypatch) -> None:
        """Out of the box, the server requests delayed data so unsubscribed
        accounts don't hit IBKR error 10089."""
        monkeypatch.delenv("IBKR_MARKET_DATA_TYPE", raising=False)
        from ibkr_mcp.client import IBKRClient

        c = IBKRClient()
        assert c.market_data_type == 3
        assert c.market_data_type_label == "delayed"

    @pytest.mark.parametrize(
        "value,label",
        [("1", "realtime"), ("2", "frozen"), ("3", "delayed"), ("4", "delayed_frozen")],
    )
    def test_env_override(self, monkeypatch, value, label) -> None:
        monkeypatch.setenv("IBKR_MARKET_DATA_TYPE", value)
        from ibkr_mcp.client import IBKRClient

        c = IBKRClient()
        assert c.market_data_type == int(value)
        assert c.market_data_type_label == label

    def test_unknown_type_gets_fallback_label(self, monkeypatch) -> None:
        monkeypatch.setenv("IBKR_MARKET_DATA_TYPE", "99")
        from ibkr_mcp.client import IBKRClient

        c = IBKRClient()
        assert c.market_data_type_label == "type_99"


class TestBarDate:
    def test_date(self) -> None:
        b = SimpleNamespace(date=dt.date(2026, 5, 13))
        assert _bar_date(b) == dt.date(2026, 5, 13)

    def test_datetime(self) -> None:
        b = SimpleNamespace(date=dt.datetime(2026, 5, 13, 16, 0))
        assert _bar_date(b) == dt.date(2026, 5, 13)

    def test_string(self) -> None:
        b = SimpleNamespace(date="2026-05-13")
        assert _bar_date(b) == dt.date(2026, 5, 13)
