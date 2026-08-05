"""
Geospatial primitives.

Production AEGIS uses Uber H3 for cell indexing and PostGIS/Redis-GEO for
nearest-neighbour queries. This module reimplements the small subset the
decision core actually needs (cell id, ring expansion, k-nearest) with no
external dependency, so the reference implementation runs anywhere and the
optimizer can be unit-tested in isolation.
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Dict, Iterable, List, Tuple

from ..domain.models import GeoPoint

EARTH_RADIUS_KM = 6371.0088

#: Edge length of a level-7 cell in degrees. ~0.05 deg latitude is roughly
#: 5.5 km, a sensible granularity for pre-computed travel-time matrices.
CELL_SIZE_DEG = 0.05


def haversine_km(a: GeoPoint, b: GeoPoint) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a.lat, a.lon, b.lat, b.lon))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))


def cell_of(p: GeoPoint, size_deg: float = CELL_SIZE_DEG) -> Tuple[int, int]:
    """Deterministic cell id. Used as the cache key for travel-time lookups."""
    return (int(math.floor(p.lat / size_deg)), int(math.floor(p.lon / size_deg)))


def cell_ring(cell: Tuple[int, int], k: int) -> List[Tuple[int, int]]:
    """All cells within Chebyshev distance k - the incremental search ring."""
    ci, cj = cell
    return [(ci + di, cj + dj)
            for di in range(-k, k + 1)
            for dj in range(-k, k + 1)]


class SpatialIndex:
    """
    Bucketed grid index over dispatchable resources.

    Chosen over a k-d tree because entries move constantly: a grid supports
    O(1) re-bucketing on every telemetry ping, whereas a balanced tree would
    need rebuilding. Query cost is O(candidates in ring), which is bounded
    because we stop expanding as soon as we have enough candidates.
    """

    def __init__(self, size_deg: float = CELL_SIZE_DEG) -> None:
        self.size_deg = size_deg
        self._buckets: Dict[Tuple[int, int], set] = defaultdict(set)
        self._where: Dict[str, Tuple[int, int]] = {}

    def upsert(self, key: str, p: GeoPoint) -> None:
        new_cell = cell_of(p, self.size_deg)
        old_cell = self._where.get(key)
        if old_cell == new_cell:
            return
        if old_cell is not None:
            self._buckets[old_cell].discard(key)
        self._buckets[new_cell].add(key)
        self._where[key] = new_cell

    def remove(self, key: str) -> None:
        old = self._where.pop(key, None)
        if old is not None:
            self._buckets[old].discard(key)

    def near(self, p: GeoPoint, want: int, max_rings: int = 12) -> List[str]:
        """
        Expanding-ring search. Returns at least `want` keys when they exist
        within `max_rings`, else everything found. The caller applies
        feasibility filters afterwards, so we over-fetch by design.
        """
        origin = cell_of(p, self.size_deg)
        found: List[str] = []
        seen = set()
        for k in range(max_rings + 1):
            for c in cell_ring(origin, k):
                if c in seen:
                    continue
                seen.add(c)
                found.extend(self._buckets.get(c, ()))
            if len(found) >= want:
                break
        return found

    def __len__(self) -> int:
        return len(self._where)


def region_of(p: GeoPoint, regions: Dict[str, GeoPoint]) -> str:
    """Nearest-centroid region assignment (production: polygon lookup in PostGIS)."""
    return min(regions.items(), key=lambda kv: haversine_km(p, kv[1]))[0]


def bearing_bucket(a: GeoPoint, b: GeoPoint, buckets: int = 8) -> int:
    """Coarse direction, used to diversify pre-positioning candidates."""
    dlon = math.radians(b.lon - a.lon)
    y = math.sin(dlon) * math.cos(math.radians(b.lat))
    x = (math.cos(math.radians(a.lat)) * math.sin(math.radians(b.lat))
         - math.sin(math.radians(a.lat)) * math.cos(math.radians(b.lat)) * math.cos(dlon))
    ang = (math.degrees(math.atan2(y, x)) + 360.0) % 360.0
    return int(ang // (360.0 / buckets))


def centroid(points: Iterable[GeoPoint]) -> GeoPoint:
    pts = list(points)
    if not pts:
        raise ValueError("centroid of empty set")
    return GeoPoint(sum(p.lat for p in pts) / len(pts),
                    sum(p.lon for p in pts) / len(pts))
