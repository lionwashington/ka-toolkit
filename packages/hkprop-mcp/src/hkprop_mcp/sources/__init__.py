"""Source registry. ``SOURCES[name]`` returns the module implementing :class:`Source`.

V1 ships with 28Hse only. V2 will add Centanet (中原地產) — register it here
once ``centanet.py`` exists and the protocol is satisfied.
"""

from __future__ import annotations

from types import ModuleType
from typing import Mapping

from . import centanet, twentyeighthse

SOURCES: Mapping[str, ModuleType] = {
    "28hse": twentyeighthse,
    "centanet": centanet,
    # "spacious": spacious,   # later — has anti-bot edge
}

DEFAULT_SOURCE = "28hse"

# Sentinel value: caller-side "fan-out across all registered sources".
ALL_SOURCES = "all"


def get(name: str) -> ModuleType:
    """Resolve a source by name. Raises ``ValueError`` if unknown.

    Pass ``"all"`` to indicate fan-out across every registered source —
    the dispatcher in ``tools.py`` handles this case, not this function.
    """
    if name == ALL_SOURCES:
        raise ValueError(
            "Use sources.all_sources() for fan-out; .get('all') is not a "
            "concrete source."
        )
    if name not in SOURCES:
        available = ", ".join(sorted(SOURCES.keys()) + [ALL_SOURCES])
        raise ValueError(
            f"Unknown source {name!r}. Available sources: {available}. "
            f"To add a new source, see sources/base.py."
        )
    return SOURCES[name]


def all_sources() -> list[ModuleType]:
    """Return every registered source for fan-out."""
    return list(SOURCES.values())


def list_sources() -> list[dict[str, str]]:
    """List all registered sources with display metadata."""
    return [
        {"name": s.name, "display_name": s.display_name}
        for s in SOURCES.values()
    ]
