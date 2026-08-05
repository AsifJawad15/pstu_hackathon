"""
Travel-time estimation.

Production AEGIS calls an OSRM/Valhalla cluster built with contraction
hierarchies, overlaid with live road-condition events. That call is the single
hottest dependency in the system, so it is wrapped in three layers:

  1. a versioned cell-to-cell cache (invalidated surgically per road event),
  2. a circuit breaker,
  3. a great-circle fallback so that dispatch NEVER blocks on routing.

The fallback is the important design point. An emergency system that stops
dispatching because a routing microservice is unhealthy has failed worse than
one that dispatches on a slightly stale estimate.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

from ..domain.models import GeoPoint, HAZARD_TRAVEL_MULTIPLIER, HazardClass, Resource, ResourceType
from ..infra.cache import VersionedTTLCache
from ..infra.circuit_breaker import CircuitBreaker, CircuitOpen
from .geo import cell_of, haversine_km

#: The cached quantity is *free-flow* travel time, which is a property of
#: the road graph and changes only when the graph changes. Live degradation
#: (closures, weather) is applied on top of the cached value at read time,
#: which is why a coarse key and a long TTL are safe here and would not be
#: if the overlay were baked in.
ETA_CACHE_CELL_DEG = 0.10

#: Road network is not straight-line; this converts crow-flight to road km.
DETOUR_FACTOR: Dict[ResourceType, float] = {
    ResourceType.AMBULANCE: 1.38,
    ResourceType.RESCUE_TEAM: 1.42,
    ResourceType.FIRE_UNIT: 1.40,
    ResourceType.HELICOPTER: 1.02,      # flies near-direct
}

#: Fixed overhead: crew mobilisation, gate-out, on-arrival positioning.
MOBILISATION_S: Dict[ResourceType, float] = {
    ResourceType.AMBULANCE: 90.0,
    ResourceType.RESCUE_TEAM: 240.0,
    ResourceType.FIRE_UNIT: 120.0,
    ResourceType.HELICOPTER: 420.0,     # spin-up dominates
}


@dataclass
class RoadCondition:
    """A degradation applied to every route touching a cell."""
    cell: Tuple[int, int]
    multiplier: float
    until: float
    reason: str


class TravelTimeService:
    """
    Estimates door-to-scene seconds.

    `estimate` is the only entry point the optimizer uses. It is deliberately
    total: it always returns a number and never raises, degrading through the
    fallback ladder instead.
    """

    def __init__(self, cache_ttl_s: float = 60.0, metrics=None) -> None:
        self.cache = VersionedTTLCache(ttl_s=cache_ttl_s, max_entries=200_000)
        self.breaker = CircuitBreaker(failure_threshold=5, reset_timeout_s=30.0)
        self.conditions: Dict[Tuple[int, int], RoadCondition] = {}
        self.metrics = metrics
        self.router_healthy = True          # flipped by chaos injection
        self._degraded_calls = 0

    # -- environment events -------------------------------------------------

    def apply_road_condition(self, cond: RoadCondition) -> None:
        """
        Surgical invalidation: bump only the version of the affected cell
        rather than flushing the whole matrix. A nationwide flush during a
        cyclone would collapse into a routing-engine stampede exactly when
        the system is busiest.
        """
        self.conditions[cond.cell] = cond
        self.cache.bump_partition(cond.cell)

    def expire_conditions(self, now: float) -> None:
        stale = [c for c, v in self.conditions.items() if v.until <= now]
        for c in stale:
            del self.conditions[c]
            self.cache.bump_partition(c)

    def condition_multiplier(self, a: GeoPoint, b: GeoPoint) -> float:
        """Worst multiplier among the endpoints' cells (cheap proxy for the
        true 'cells the route crosses' set, which the real router returns)."""
        m = 1.0
        for cell in (cell_of(a), cell_of(b)):
            cond = self.conditions.get(cell)
            if cond is not None:
                m = max(m, cond.multiplier)
        return m

    # -- estimation ---------------------------------------------------------

    def _route_call(self, a: GeoPoint, b: GeoPoint, rtype: ResourceType, speed: float) -> float:
        if not self.router_healthy:
            raise RuntimeError("routing engine unavailable")
        km = haversine_km(a, b) * DETOUR_FACTOR.get(rtype, 1.35)
        return (km / max(speed, 1.0)) * 3600.0

    def _fallback(self, a: GeoPoint, b: GeoPoint, rtype: ResourceType, speed: float) -> float:
        """Great-circle with a conservative penalty, so degraded estimates are
        pessimistic rather than optimistic. Over-promising in an emergency is
        the more dangerous error."""
        km = haversine_km(a, b) * DETOUR_FACTOR.get(rtype, 1.35) * 1.15
        return (km / max(speed * 0.9, 1.0)) * 3600.0

    def estimate(
        self,
        origin: GeoPoint,
        dest: GeoPoint,
        rtype: ResourceType,
        speed_kmph: float,
        hazard: HazardClass = HazardClass.NONE,
        now: float = 0.0,
    ) -> float:
        key = (cell_of(origin, ETA_CACHE_CELL_DEG), cell_of(dest, ETA_CACHE_CELL_DEG),
               rtype.value, round(speed_kmph))
        partition = cell_of(dest)
        hit = self.cache.get(key, partition, now)
        if hit is not None:
            if self.metrics:
                self.metrics.incr("eta.cache.hit")
            base = hit
        else:
            if self.metrics:
                self.metrics.incr("eta.cache.miss")
            try:
                base = self.breaker.call(self._route_call, origin, dest, rtype, speed_kmph, now=now)
            except (CircuitOpen, RuntimeError):
                self._degraded_calls += 1
                if self.metrics:
                    self.metrics.incr("eta.degraded")
                base = self._fallback(origin, dest, rtype, speed_kmph)
            self.cache.put(key, base, partition, now)

        road = self.condition_multiplier(origin, dest)
        hz = HAZARD_TRAVEL_MULTIPLIER.get(hazard, 1.0)
        # Helicopters ignore road closures but not weather.
        if rtype == ResourceType.HELICOPTER:
            road = 1.0
            hz = min(hz, 1.35)
        return MOBILISATION_S.get(rtype, 120.0) + base * road * hz

    def estimate_for(self, res: Resource, dest: GeoPoint, hazard: HazardClass, now: float) -> float:
        return self.estimate(res.location, dest, res.resource_type,
                             res.speed_kmph, hazard, now)

    @property
    def degraded_calls(self) -> int:
        return self._degraded_calls

    def stats(self) -> Dict[str, float]:
        s = dict(self.cache.stats())
        s["degraded_calls"] = self._degraded_calls
        s["breaker_state"] = self.breaker.state
        return s
