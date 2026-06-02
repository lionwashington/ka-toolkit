"""Safety enforcement tests — no IB Gateway needed."""

from __future__ import annotations

import os
import subprocess
import sys

import pytest


def test_readonly_grep_passes() -> None:
    """The check-readonly.sh script must pass on clean source."""
    here = os.path.dirname(__file__)
    script = os.path.abspath(os.path.join(here, "..", "scripts", "check-readonly.sh"))
    result = subprocess.run(
        ["bash", script], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, (
        f"check-readonly.sh failed:\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )


def test_readonly_grep_catches_forbidden(tmp_path) -> None:
    """If a forbidden pattern is added to src/, the grep must fail."""
    here = os.path.dirname(__file__)
    pkg_root = os.path.abspath(os.path.join(here, ".."))
    naughty = os.path.join(pkg_root, "src", "ibkr_mcp", "_naughty_temp.py")
    try:
        with open(naughty, "w") as f:
            f.write("# Should be caught:\nplaceOrder = 'no'\n")
        script = os.path.join(pkg_root, "scripts", "check-readonly.sh")
        result = subprocess.run(
            ["bash", script], capture_output=True, text=True, check=False
        )
        assert result.returncode == 1, "grep should have failed"
        assert "placeOrder" in result.stdout
    finally:
        if os.path.exists(naughty):
            os.remove(naughty)


def test_enforce_readonly_blocks_allow_trading(monkeypatch) -> None:
    from ibkr_mcp import safety

    monkeypatch.setenv("IBKR_ALLOW_TRADING", "true")
    with pytest.raises(SystemExit) as exc_info:
        safety.enforce_readonly()
    assert exc_info.value.code == 2


def test_enforce_readonly_blocks_non_loopback(monkeypatch) -> None:
    from ibkr_mcp import safety

    monkeypatch.delenv("IBKR_ALLOW_TRADING", raising=False)
    monkeypatch.setenv("IBKR_HOST", "192.168.1.10")
    with pytest.raises(SystemExit) as exc_info:
        safety.enforce_readonly()
    assert exc_info.value.code == 2


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
def test_enforce_readonly_accepts_loopback(monkeypatch, host) -> None:
    from ibkr_mcp import safety

    monkeypatch.delenv("IBKR_ALLOW_TRADING", raising=False)
    monkeypatch.setenv("IBKR_HOST", host)
    safety.enforce_readonly()  # must not raise


def test_enforce_readonly_passes_default(monkeypatch) -> None:
    from ibkr_mcp import safety

    monkeypatch.delenv("IBKR_ALLOW_TRADING", raising=False)
    monkeypatch.delenv("IBKR_HOST", raising=False)
    safety.enforce_readonly()  # must not raise


@pytest.mark.parametrize("val", ["1", "true", "TRUE", "yes", "on"])
def test_allow_trading_truthy_values_block(monkeypatch, val) -> None:
    from ibkr_mcp import safety

    monkeypatch.setenv("IBKR_ALLOW_TRADING", val)
    with pytest.raises(SystemExit):
        safety.enforce_readonly()


@pytest.mark.parametrize("val", ["", "0", "false", "no", "anything-else"])
def test_allow_trading_falsy_values_pass(monkeypatch, val) -> None:
    from ibkr_mcp import safety

    monkeypatch.setenv("IBKR_ALLOW_TRADING", val)
    monkeypatch.delenv("IBKR_HOST", raising=False)
    safety.enforce_readonly()
