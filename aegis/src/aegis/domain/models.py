"""
AEGIS domain model.

Deliberately framework-free: these types carry no persistence, transport or
scheduling concerns. Everything else in the system (event bus, stores,
optimizer, simulator) depends on this module and never the reverse. That is
what lets the same decision core run inside the reference simulator here and
inside a production service without modification.
"""
from __future__ import annotations

import enum
import itertools
import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


# --------------------------------------------------------------------------
# Enumerations
# --------------------------------------------------------------------------

class ResourceType(str, enum.Enum):
    AMBULANCE = "AMBULANCE"
    RESCUE_TEAM = "RESCUE_TEAM"
    HELICOPTER = "HELICOPTER"
    FIRE_UNIT = "FIRE_UNIT"
    HOSPITAL = "HOSPITAL"          # fixed capacity node, not dispatched
    EOC = "EOC"                    # emergency operations centre


DISPATCHABLE = {
    ResourceType.AMBULANCE,
    ResourceType.RESCUE_TEAM,
    ResourceType.HELICOPTER,
    ResourceType.FIRE_UNIT,
}


class ResourceState(str, enum.Enum):
    AVAILABLE = "AVAILABLE"
    RESERVED = "RESERVED"          # lease held, not yet committed
    EN_ROUTE = "EN_ROUTE"
    ON_SCENE = "ON_SCENE"
    TRANSPORTING = "TRANSPORTING"
    OUT_OF_SERVICE = "OUT_OF_SERVICE"


class IncidentState(str, enum.Enum):
    RECEIVED = "RECEIVED"
    TRIAGED = "TRIAGED"
    PARTIALLY_ASSIGNED = "PARTIALLY_ASSIGNED"
    FULLY_ASSIGNED = "FULLY_ASSIGNED"
    IN_PROGRESS = "IN_PROGRESS"
    RESOLVED = "RESOLVED"
    EXPIRED = "EXPIRED"            # deadline passed with no responder


class AssignmentState(str, enum.Enum):
    PROPOSED = "PROPOSED"          # solver output, revocable for free
    COMMITTED = "COMMITTED"        # crew notified, revocable with penalty
    EN_ROUTE = "EN_ROUTE"          # moving, revocable only at high penalty
    ARRIVED = "ARRIVED"            # irrevocable
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class HazardClass(str, enum.Enum):
    NONE = "NONE"
    FLOOD = "FLOOD"
    CYCLONE = "CYCLONE"
    FIRE = "FIRE"
    STRUCTURAL_COLLAPSE = "STRUCTURAL_COLLAPSE"
    CHEMICAL = "CHEMICAL"


#: Multiplier applied to travel time and to the risk term of the priority
#: score. Sourced from configuration in production; inlined here so the
#: reference implementation is self-contained and reproducible.
HAZARD_TRAVEL_MULTIPLIER: Dict[HazardClass, float] = {
    HazardClass.NONE: 1.00,
    HazardClass.FLOOD: 1.85,
    HazardClass.CYCLONE: 1.60,
    HazardClass.FIRE: 1.15,
    HazardClass.STRUCTURAL_COLLAPSE: 1.10,
    HazardClass.CHEMICAL: 1.30,
}

HAZARD_RISK_SCORE: Dict[HazardClass, float] = {
    HazardClass.NONE: 0.00,
    HazardClass.FLOOD: 0.70,
    HazardClass.CYCLONE: 0.85,
    HazardClass.FIRE: 0.90,
    HazardClass.STRUCTURAL_COLLAPSE: 1.00,
    HazardClass.CHEMICAL: 0.95,
}


# --------------------------------------------------------------------------
# Value objects
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class GeoPoint:
    lat: float
    lon: float

    def as_tuple(self) -> Tuple[float, float]:
        return (self.lat, self.lon)


@dataclass(frozen=True)
class Requirement:
    """One line of an incident's resource bill of materials."""
    resource_type: ResourceType
    count: int
    min_capability: int = 1        # 1..3, higher = better equipped


# --------------------------------------------------------------------------
# Entities
# --------------------------------------------------------------------------

_incident_seq = itertools.count(1)
_resource_seq = itertools.count(1)
_assignment_seq = itertools.count(1)


@dataclass
class Incident:
    location: GeoPoint
    region_id: str
    severity: int                       # 1 (minor) .. 5 (catastrophic)
    affected_people: int
    #: Seconds from report until clinical/structural outcome degrades sharply.
    time_window_s: float
    requirements: List[Requirement]
    hazard: HazardClass = HazardClass.NONE
    vulnerability: float = 0.0          # 0..1 (children, elderly, disabled)
    reported_at: float = 0.0

    incident_id: str = field(default_factory=lambda: f"INC-{next(_incident_seq):07d}")
    state: IncidentState = IncidentState.RECEIVED
    version: int = 0                    # optimistic concurrency token

    # runtime bookkeeping -------------------------------------------------
    assigned: Dict[ResourceType, int] = field(default_factory=dict)
    first_arrival_at: Optional[float] = None
    resolved_at: Optional[float] = None
    priority: float = 0.0
    priority_breakdown: Dict[str, float] = field(default_factory=dict)

    @property
    def deadline(self) -> float:
        return self.reported_at + self.time_window_s

    def required_count(self, rtype: ResourceType) -> int:
        return sum(r.count for r in self.requirements if r.resource_type == rtype)

    def outstanding(self) -> Dict[ResourceType, int]:
        """Requirement lines not yet covered by a live assignment."""
        out: Dict[ResourceType, int] = {}
        for req in self.requirements:
            need = req.count - self.assigned.get(req.resource_type, 0)
            if need > 0:
                out[req.resource_type] = out.get(req.resource_type, 0) + need
        return out

    def is_open(self) -> bool:
        return self.state not in (IncidentState.RESOLVED, IncidentState.EXPIRED)

    def response_time(self) -> Optional[float]:
        if self.first_arrival_at is None:
            return None
        return self.first_arrival_at - self.reported_at


@dataclass
class Resource:
    resource_type: ResourceType
    location: GeoPoint
    region_id: str
    home_base: GeoPoint
    capability: int = 2                 # 1..3
    speed_kmph: float = 45.0
    capacity: int = 1                   # beds for HOSPITAL, patients for AMBULANCE

    resource_id: str = field(default_factory=lambda: f"RES-{next(_resource_seq):07d}")
    state: ResourceState = ResourceState.AVAILABLE
    version: int = 0
    occupied: int = 0                   # used capacity (hospitals)

    # runtime bookkeeping -------------------------------------------------
    current_assignment: Optional[str] = None
    busy_since: Optional[float] = None
    busy_seconds_total: float = 0.0
    trips: int = 0
    failures: int = 0

    def is_dispatchable(self) -> bool:
        return self.resource_type in DISPATCHABLE

    def is_free(self) -> bool:
        return self.state == ResourceState.AVAILABLE

    def free_capacity(self) -> int:
        return max(0, self.capacity - self.occupied)


@dataclass
class Assignment:
    incident_id: str
    resource_id: str
    resource_type: ResourceType
    eta_s: float
    created_at: float
    cost: float
    state: AssignmentState = AssignmentState.PROPOSED
    assignment_id: str = field(default_factory=lambda: f"ASG-{next(_assignment_seq):07d}")
    depart_at: Optional[float] = None
    arrive_at: Optional[float] = None
    #: Needed to project where an en-route unit actually is right now. Without
    #: this the optimizer keeps re-costing a moving vehicle from the depot it
    #: left twenty minutes ago and churns it endlessly.
    origin: Optional[GeoPoint] = None
    dest: Optional[GeoPoint] = None
    generation: int = 0                 # solver epoch that produced it
    supersedes: Optional[str] = None
    #: Serialised explanation - the audit substrate for every decision.
    rationale: Dict[str, object] = field(default_factory=dict)

    def is_live(self) -> bool:
        return self.state in (
            AssignmentState.PROPOSED,
            AssignmentState.COMMITTED,
            AssignmentState.EN_ROUTE,
            AssignmentState.ARRIVED,
        )

    def is_revocable(self) -> bool:
        """Only pre-arrival assignments may be re-optimised away."""
        return self.state in (
            AssignmentState.PROPOSED,
            AssignmentState.COMMITTED,
            AssignmentState.EN_ROUTE,
        )

    def progress(self, now: float) -> float:
        """Fraction of the journey completed, 0..1."""
        if self.depart_at is None or self.arrive_at is None:
            return 0.0
        span = self.arrive_at - self.depart_at
        if span <= 0:
            return 1.0
        return max(0.0, min(1.0, (now - self.depart_at) / span))

    def projected_position(self, now: float) -> Optional[GeoPoint]:
        if self.origin is None or self.dest is None:
            return None
        f = self.progress(now)
        return GeoPoint(self.origin.lat + f * (self.dest.lat - self.origin.lat),
                        self.origin.lon + f * (self.dest.lon - self.origin.lon))

    def switching_penalty(self) -> float:
        """Cost of tearing this assignment up, in 'urgency-minutes'."""
        return {
            AssignmentState.PROPOSED: 0.0,
            AssignmentState.COMMITTED: 40.0,
            AssignmentState.EN_ROUTE: 160.0,
        }.get(self.state, math.inf)


def reset_id_sequences() -> None:
    """Test helper - makes IDs deterministic across runs."""
    global _incident_seq, _resource_seq, _assignment_seq
    _incident_seq = itertools.count(1)
    _resource_seq = itertools.count(1)
    _assignment_seq = itertools.count(1)
