"""Protocol every property data source must satisfy.

A Source is the *only* place that knows the URL shape, HTML structure, and
PDPO posture of a specific website. Everything outside ``sources/`` talks to
the normalized :mod:`models` types.

To add a new source (e.g. Centanet in V2):
  1. Create ``sources/centanet.py`` with ``search`` / ``get_detail`` /
     ``agent_contact`` async functions matching this Protocol.
  2. Register it in ``sources/__init__.py``.

V1 ships with ``twentyeighthse`` only.
"""

from __future__ import annotations

from typing import Protocol

from ..models import AgentContact, Listing, SearchResult


class Source(Protocol):
    """Async interface every property data source must implement."""

    name: str  # canonical id, e.g. "28hse"
    display_name: str  # human-readable, e.g. "28Hse 香港屋網"

    async def search(
        self,
        district_code: str | None = None,
        building_type: str = "apartment",
        min_price: int | None = None,
        max_price: int | None = None,
        min_rooms: int | None = None,
        min_size: int | None = None,
        max_size: int | None = None,
        page: int = 1,
    ) -> SearchResult:
        """Search rental listings. ``district_code`` None = all HK."""
        ...

    async def get_detail(self, source_id: str) -> Listing:
        """Fetch full detail for one listing by source-specific id."""
        ...

    async def agent_contact(self, source_id: str) -> AgentContact:
        """Return agent contact + PDPO warning for one listing."""
        ...
