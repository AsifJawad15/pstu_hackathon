"""
Deterministic scenario generation.

The incident stream and every environmental disruption are generated *once*
from a fixed seed and then replayed identically against each dispatch policy.
Without that, a comparison between policies measures the random number
generator as much as the engineering. Specs are plain data; live entities are
rebuilt per run so no state leaks between them.

The scenario is built to punish naive dispatch, because that is where the
architecture has to earn its keep:

* a **background load** of routine calls across eight administrative regions,
* a **cyclone surge** that concentrates demand in three coastal regions while
  simultaneously degrading travel there,
* **road closures**, **vehicle failures**, **hospital saturation** and a
  **routing-engine outage**, so the fallback ladder is actually exercised.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from ..domain.models import (GeoPoint, HazardClass, Incident, Requirement,
                             Resource, ResourceType)

# Eight regional centroids of a mid-sized delta country: a realistic mix of
# one dense capital region, coastal cyclone exposure and remote interior.
REGIONS: Dict[str, GeoPoint] = {
    "R-CAPITAL":  GeoPoint(23.81, 90.41),
    "R-PORT":     GeoPoint(22.36, 91.78),
    "R-SOUTHWEST": GeoPoint(22.85, 89.54),
    "R-NORTHWEST": GeoPoint(24.37, 88.60),
    "R-NORTHEAST": GeoPoint(24.90, 91.87),
    "R-COASTAL":  GeoPoint(22.70, 90.37),
    "R-NORTH":    GeoPoint(25.75, 89.25),
    "R-CENTRAL":  GeoPoint(24.75, 90.40),
}

#: Relative share of routine demand - the capital dominates.
REGION_WEIGHT = {
    "R-CAPITAL": 0.30, "R-PORT": 0.16, "R-SOUTHWEST": 0.10, "R-NORTHWEST": 0.10,
    "R-NORTHEAST": 0.09, "R-COASTAL": 0.09, "R-NORTH": 0.08, "R-CENTRAL": 0.08,
}

SURGE_REGIONS = ["R-COASTAL", "R-SOUTHWEST", "R-PORT"]


@dataclass(frozen=True)
class IncidentTemplate:
    name: str
    weight: float
    severity_range: Tuple[int, int]
    people_range: Tuple[int, int]
    window_min_range: Tuple[float, float]
    requirements: Tuple[Tuple[ResourceType, int, int], ...]
    hazard: HazardClass = HazardClass.NONE
    vulnerability_range: Tuple[float, float] = (0.0, 0.4)


TEMPLATES: List[IncidentTemplate] = [
    IncidentTemplate("MEDICAL", 0.34, (1, 3), (1, 2), (28, 68),
                     ((ResourceType.AMBULANCE, 1, 1),)),
    IncidentTemplate("ROAD_ACCIDENT", 0.22, (2, 4), (2, 12), (22, 52),
                     ((ResourceType.AMBULANCE, 2, 1),)),
    IncidentTemplate("STRUCTURE_FIRE", 0.13, (3, 5), (5, 60), (19, 42),
                     ((ResourceType.FIRE_UNIT, 2, 1), (ResourceType.AMBULANCE, 1, 1)),
                     HazardClass.FIRE, (0.1, 0.6)),
    IncidentTemplate("BUILDING_COLLAPSE", 0.08, (4, 5), (10, 220), (38, 105),
                     ((ResourceType.RESCUE_TEAM, 2, 2), (ResourceType.AMBULANCE, 3, 1)),
                     HazardClass.STRUCTURAL_COLLAPSE, (0.2, 0.8)),
    IncidentTemplate("FLOOD_RESCUE", 0.10, (3, 5), (15, 400), (45, 135),
                     ((ResourceType.RESCUE_TEAM, 1, 1), (ResourceType.AMBULANCE, 1, 1)),
                     HazardClass.FLOOD, (0.3, 0.9)),
    IncidentTemplate("MASS_CASUALTY", 0.05, (4, 5), (40, 600), (30, 75),
                     ((ResourceType.AMBULANCE, 4, 1), (ResourceType.RESCUE_TEAM, 1, 2)),
                     HazardClass.NONE, (0.2, 0.7)),
    IncidentTemplate("REMOTE_EVACUATION", 0.05, (4, 5), (1, 20), (33, 82),
                     ((ResourceType.HELICOPTER, 1, 1), (ResourceType.AMBULANCE, 1, 1)),
                     HazardClass.CYCLONE, (0.3, 0.9)),
    IncidentTemplate("CHEMICAL_LEAK", 0.03, (3, 5), (5, 150), (24, 60),
                     ((ResourceType.FIRE_UNIT, 2, 2), (ResourceType.RESCUE_TEAM, 1, 2),
                      (ResourceType.AMBULANCE, 2, 1)),
                     HazardClass.CHEMICAL, (0.2, 0.7)),
]


@dataclass
class IncidentSpec:
    t: float
    lat: float
    lon: float
    region_id: str
    severity: int
    affected_people: int
    time_window_s: float
    requirements: Tuple[Tuple[str, int, int], ...]
    hazard: str
    vulnerability: float
    template: str

    def build(self) -> Incident:
        return Incident(
            location=GeoPoint(self.lat, self.lon),
            region_id=self.region_id,
            severity=self.severity,
            affected_people=self.affected_people,
            time_window_s=self.time_window_s,
            requirements=[Requirement(ResourceType(t), c, cap)
                          for t, c, cap in self.requirements],
            hazard=HazardClass(self.hazard),
            vulnerability=self.vulnerability,
            reported_at=self.t,
        )


@dataclass
class EnvEvent:
    t: float
    kind: str                                   # ROAD_CLOSURE | VEHICLE_FAILURE | ROUTER_OUTAGE
    payload: Dict[str, object] = field(default_factory=dict)


@dataclass
class FleetSpec:
    region_id: str
    resource_type: str
    lat: float
    lon: float
    capability: int
    speed_kmph: float
    capacity: int

    def build(self) -> Resource:
        p = GeoPoint(self.lat, self.lon)
        return Resource(resource_type=ResourceType(self.resource_type), location=p,
                        region_id=self.region_id, home_base=p,
                        capability=self.capability, speed_kmph=self.speed_kmph,
                        capacity=self.capacity)


@dataclass
class Scenario:
    fleet: List[FleetSpec]
    incidents: List[IncidentSpec]
    env_events: List[EnvEvent]
    horizon_s: float
    surge_window: Tuple[float, float]

    def summary(self) -> Dict[str, object]:
        by_type: Dict[str, int] = {}
        for f in self.fleet:
            by_type[f.resource_type] = by_type.get(f.resource_type, 0) + 1
        by_tmpl: Dict[str, int] = {}
        for i in self.incidents:
            by_tmpl[i.template] = by_tmpl.get(i.template, 0) + 1
        return {
            "fleet_total": len(self.fleet),
            "fleet_by_type": by_type,
            "incidents": len(self.incidents),
            "incidents_by_template": by_tmpl,
            "env_events": len(self.env_events),
            "horizon_hours": round(self.horizon_s / 3600.0, 2),
            "surge_window_h": (round(self.surge_window[0] / 3600, 2),
                               round(self.surge_window[1] / 3600, 2)),
        }


# --------------------------------------------------------------------------

def _jitter(rng: random.Random, centre: GeoPoint, sigma_deg: float) -> GeoPoint:
    return GeoPoint(centre.lat + rng.gauss(0, sigma_deg),
                    centre.lon + rng.gauss(0, sigma_deg))


def build_fleet(rng: random.Random, scale: float = 1.0) -> List[FleetSpec]:
    """
    Deliberately under-resourced relative to peak demand. If the fleet can
    absorb the surge trivially, every policy looks identical and the
    comparison proves nothing; scarcity is what makes allocation quality
    observable.
    """
    spec: List[FleetSpec] = []
    per_region = {
        ResourceType.AMBULANCE: (14, 60.0, 1),
        ResourceType.FIRE_UNIT: (5, 50.0, 1),
        ResourceType.RESCUE_TEAM: (4, 42.0, 1),
        ResourceType.HOSPITAL: (4, 0.0, 26),
    }
    for region, centre in REGIONS.items():
        w = REGION_WEIGHT[region] * len(REGIONS)
        for rtype, (base, speed, cap) in per_region.items():
            n = max(1, int(round(base * w * scale)))
            for _ in range(n):
                p = _jitter(rng, centre, 0.16 if rtype != ResourceType.HOSPITAL else 0.10)
                capability = rng.choices([1, 2, 3], weights=[0.35, 0.45, 0.20])[0]
                spec.append(FleetSpec(region, rtype.value, p.lat, p.lon,
                                      capability, speed, cap))
        spec.append(FleetSpec(region, ResourceType.EOC.value, centre.lat, centre.lon, 3, 0.0, 1))

    # Helicopters are a national, not regional, asset: four airframes total.
    for region in ["R-CAPITAL", "R-PORT", "R-NORTH", "R-NORTHEAST"]:
        c = REGIONS[region]
        spec.append(FleetSpec(region, ResourceType.HELICOPTER.value, c.lat, c.lon,
                              3, 210.0, 4))
    return spec


def build_incidents(rng: random.Random, horizon_s: float,
                    base_rate_per_h: float, surge_multiplier: float,
                    surge_window: Tuple[float, float]) -> List[IncidentSpec]:
    specs: List[IncidentSpec] = []
    t = 0.0
    regions = list(REGIONS)
    weights = [REGION_WEIGHT[r] for r in regions]
    tmpl_weights = [tm.weight for tm in TEMPLATES]

    while t < horizon_s:
        in_surge = surge_window[0] <= t <= surge_window[1]
        rate_h = base_rate_per_h * (surge_multiplier if in_surge else 1.0)
        # Diurnal modulation: demand is not uniform over a day.
        hour = (t / 3600.0) % 24.0
        diurnal = 0.72 + 0.55 * math.sin((hour - 7.0) / 24.0 * 2 * math.pi) ** 2
        lam = max(1e-6, rate_h * diurnal / 3600.0)
        t += rng.expovariate(lam)
        if t >= horizon_s:
            break

        if in_surge and rng.random() < 0.62:
            region = rng.choice(SURGE_REGIONS)
        else:
            region = rng.choices(regions, weights=weights)[0]
        centre = REGIONS[region]
        # Heavier tail than a Gaussian: some calls come from far outside the
        # regional centre, which is where naive nearest-unit dispatch breaks.
        sigma = 0.15 if rng.random() > 0.15 else 0.34
        p = _jitter(rng, centre, sigma)

        if in_surge and region in SURGE_REGIONS:
            tmpl = rng.choices(
                TEMPLATES,
                weights=[w * (3.4 if tm.hazard in (HazardClass.FLOOD, HazardClass.CYCLONE,
                                                   HazardClass.STRUCTURAL_COLLAPSE) else 0.7)
                         for tm, w in zip(TEMPLATES, tmpl_weights)])[0]
        else:
            tmpl = rng.choices(TEMPLATES, weights=tmpl_weights)[0]

        sev = rng.randint(*tmpl.severity_range)
        if in_surge and region in SURGE_REGIONS:
            sev = min(5, sev + rng.choice([0, 0, 1]))
        people = int(rng.triangular(tmpl.people_range[0], tmpl.people_range[1],
                                    tmpl.people_range[0]))
        window_min = rng.uniform(*tmpl.window_min_range)
        specs.append(IncidentSpec(
            t=t, lat=p.lat, lon=p.lon, region_id=region, severity=sev,
            affected_people=max(1, people), time_window_s=window_min * 60.0,
            requirements=tuple((rt.value, c, cap) for rt, c, cap in tmpl.requirements),
            hazard=tmpl.hazard.value,
            vulnerability=round(rng.uniform(*tmpl.vulnerability_range), 3),
            template=tmpl.name))
    return specs


def build_env_events(rng: random.Random, horizon_s: float,
                     surge_window: Tuple[float, float],
                     n_fleet: int) -> List[EnvEvent]:
    evs: List[EnvEvent] = []

    # Road closures - clustered during the surge, as flooding cuts routes.
    t = 0.0
    while t < horizon_s:
        in_surge = surge_window[0] <= t <= surge_window[1]
        lam = (1.0 / 900.0) if in_surge else (1.0 / 5400.0)
        t += rng.expovariate(lam)
        if t >= horizon_s:
            break
        region = rng.choice(SURGE_REGIONS if in_surge else list(REGIONS))
        c = REGIONS[region]
        evs.append(EnvEvent(t, "ROAD_CLOSURE", {
            "lat": c.lat + rng.gauss(0, 0.25), "lon": c.lon + rng.gauss(0, 0.25),
            "multiplier": round(rng.uniform(1.6, 3.4), 2),
            "duration_s": rng.uniform(900, 5400),
            "reason": rng.choice(["flood_inundation", "landslide", "bridge_closure",
                                  "crowd_obstruction"]),
        }))

    # Vehicle failures / maintenance.
    t = 0.0
    while t < horizon_s:
        t += rng.expovariate(1.0 / 1200.0)
        if t >= horizon_s:
            break
        evs.append(EnvEvent(t, "VEHICLE_FAILURE", {
            "duration_s": rng.uniform(1200, 5400),
            "pick": rng.random(),
            "reason": rng.choice(["mechanical", "fuel", "crew_rest", "scheduled_maintenance"]),
        }))

    # One routing-engine partial outage, mid-surge, to exercise the fallback.
    outage_start = surge_window[0] + 0.35 * (surge_window[1] - surge_window[0])
    evs.append(EnvEvent(outage_start, "ROUTER_OUTAGE", {"duration_s": 900.0}))

    evs.sort(key=lambda e: e.t)
    return evs


def build_scenario(seed: int = 20260806, hours: float = 12.0,
                   base_rate_per_h: float = 16.0, surge_multiplier: float = 4.2,
                   fleet_scale: float = 1.0) -> Scenario:
    rng = random.Random(seed)
    horizon = hours * 3600.0
    surge = (0.30 * horizon, 0.62 * horizon)
    fleet = build_fleet(rng, fleet_scale)
    incidents = build_incidents(rng, horizon, base_rate_per_h, surge_multiplier, surge)
    env = build_env_events(rng, horizon, surge, len(fleet))
    return Scenario(fleet=fleet, incidents=incidents, env_events=env,
                    horizon_s=horizon, surge_window=surge)
