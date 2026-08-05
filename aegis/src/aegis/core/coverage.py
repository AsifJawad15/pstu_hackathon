"""
Coverage awareness and proactive relocation.

A dispatcher that only reacts is always one step behind. Two mechanisms make
AEGIS forward-looking:

* **Reserve protection.** Assigning the last free ambulance in a district is
  not free - it externalises risk onto the next call from that district. That
  opportunity cost enters the assignment cost matrix directly as a coverage
  penalty proportional to the district's forecast arrival rate.

* **Idle relocation.** Between incidents, idle units drift toward the
  expected-demand centroid of under-covered cells (a lightweight MEXCLP-style
  redeployment). This converts idle time into reduced future response time
  at zero marginal cost.

Demand is forecast with an exponentially-weighted arrival rate per region
plus a self-exciting term: disasters cluster (aftershocks, flood
propagation, secondary fires), so a recent incident raises the short-term
expectation of another nearby. That is a Hawkes-process intuition applied at
a granularity cheap enough to update on every event.
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Dict, List, Optional

from ..domain.models import GeoPoint, Resource, ResourceType


class DemandForecaster:
    def __init__(self, halflife_s: float = 1800.0, excite_gain: float = 0.6,
                 excite_decay_s: float = 600.0) -> None:
        self.halflife_s = halflife_s
        self.excite_gain = excite_gain
        self.excite_decay_s = excite_decay_s
        self._rate: Dict[str, float] = defaultdict(float)      # per second
        self._excite: Dict[str, float] = defaultdict(float)
        self._last: Dict[str, float] = defaultdict(float)

    def _decay(self, region: str, now: float) -> None:
        dt = max(0.0, now - self._last[region])
        if dt <= 0:
            return
        self._rate[region] *= math.exp(-dt * math.log(2) / self.halflife_s)
        self._excite[region] *= math.exp(-dt / self.excite_decay_s)
        self._last[region] = now

    def observe(self, region: str, now: float, weight: float = 1.0) -> None:
        self._decay(region, now)
        self._rate[region] += weight / self.halflife_s
        self._excite[region] += self.excite_gain * weight

    def rate(self, region: str, now: float) -> float:
        """Expected incidents per hour, base rate plus self-excitation."""
        self._decay(region, now)
        return (self._rate[region] + self._excite[region] / self.excite_decay_s) * 3600.0

    def snapshot(self, now: float) -> Dict[str, float]:
        return {r: self.rate(r, now) for r in set(self._rate) | set(self._excite)}


class CoverageModel:
    def __init__(self, forecaster: DemandForecaster, min_free_per_region: int = 2,
                 penalty_weight: float = 8.0) -> None:
        self.forecaster = forecaster
        self.min_free_per_region = min_free_per_region
        self.penalty_weight = penalty_weight

    def free_counts(self, resources: List[Resource]) -> Dict[tuple, int]:
        counts: Dict[tuple, int] = defaultdict(int)
        for r in resources:
            if r.is_free() and r.is_dispatchable():
                counts[(r.region_id, r.resource_type)] += 1
        return counts

    def penalty(self, res: Resource, free_counts: Dict[tuple, int], now: float) -> float:
        """
        Marginal cost of stripping `res` from its home region.

        Zero while the region is comfortably covered; rises steeply as the
        last units are consumed, weighted by how likely that region is to
        need them soon.
        """
        key = (res.region_id, res.resource_type)
        remaining = free_counts.get(key, 0) - 1
        if remaining >= self.min_free_per_region:
            return 0.0
        deficit = self.min_free_per_region - max(0, remaining)
        demand = self.forecaster.rate(res.region_id, now)
        return self.penalty_weight * deficit * (1.0 + demand)

    def relocation_targets(self, idle: List[Resource], region_centroids: Dict[str, GeoPoint],
                           now: float, top_k: int = 3) -> Dict[str, GeoPoint]:
        """
        Map idle resource -> reposition target.

        Deliberately conservative: only units that are idle and whose own
        region is over-covered are moved, and only toward the top-k
        under-covered regions. Aggressive churn burns fuel and crew hours for
        marginal expected gain, and crews distrust a system that moves them
        constantly.
        """
        free = self.free_counts(idle)
        demand = self.forecaster.snapshot(now)
        scored: List[tuple] = []
        for region, centroid in region_centroids.items():
            covered = sum(v for (rg, _), v in free.items() if rg == region)
            gap = demand.get(region, 0.0) - covered
            scored.append((gap, region, centroid))
        scored.sort(reverse=True, key=lambda t: t[0])
        needy = [(rg, c) for gap, rg, c in scored[:top_k] if gap > 0]
        if not needy:
            return {}

        targets: Dict[str, GeoPoint] = {}
        donors = [r for r in idle
                  if r.is_free() and r.is_dispatchable()
                  and free.get((r.region_id, r.resource_type), 0) > self.min_free_per_region + 1]
        for res, (rg, centroid) in zip(donors, needy * 4):
            if res.region_id == rg:
                continue
            targets[res.resource_id] = centroid
        return targets
