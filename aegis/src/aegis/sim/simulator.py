"""
Discrete-event simulation harness.

This is the evaluation rig, not part of the production system - but it drives
the *real* decision core (`core.optimizer`, `core.priority`, `core.matching`,
`infra.store`), so the numbers it produces describe the actual engine rather
than a mock-up of one.

It models the full lifecycle the problem statement calls for: incidents
arrive continuously, units mobilise and travel, hospitals fill and free beds,
roads close, vehicles fail, and the routing dependency goes down mid-surge.

Policy ablation is the point. Every policy runs against a byte-identical
event stream, so the difference between rows in the results table is
attributable to the decision logic alone.
"""
from __future__ import annotations

import heapq
import random
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from ..core.coverage import CoverageModel, DemandForecaster
from ..core.eta import RoadCondition, TravelTimeService
from ..core.geo import cell_of, haversine_km
from ..core.optimizer import DispatchEngine, OptimizerConfig
from ..core import priority
from ..domain.models import (Assignment, AssignmentState, DISPATCHABLE, GeoPoint,
                             HazardClass, Incident, IncidentState, Resource,
                             ResourceState, ResourceType, reset_id_sequences)
from ..infra.event_bus import EventBus
from ..infra.metrics import Metrics
from ..infra.store import StateStore
from .scenario import REGIONS, Scenario

#: On-scene service duration ranges, seconds.
SERVICE_S: Dict[ResourceType, Tuple[float, float]] = {
    ResourceType.AMBULANCE: (360, 900),
    ResourceType.FIRE_UNIT: (1200, 3000),
    ResourceType.RESCUE_TEAM: (1500, 4200),
    ResourceType.HELICOPTER: (600, 1200),
}

TRANSPORT_PROBABILITY = 0.72
BED_OCCUPANCY_S = (2400.0, 12600.0)


@dataclass
class PolicyConfig:
    name: str
    use_priority: bool = True
    use_reoptimisation: bool = True
    use_coverage: bool = True
    use_opportunity_cost: bool = True     # scarcity + over-qualification terms
    use_deadline_term: bool = True
    epoch_s: float = 30.0
    reopt_debounce_s: float = 15.0
    label: str = ""


POLICIES: Dict[str, PolicyConfig] = {
    "baseline": PolicyConfig(
        "baseline", use_priority=False, use_reoptimisation=False, use_coverage=False,
        use_opportunity_cost=False, use_deadline_term=False,
        label="FCFS nearest-available (industry-standard baseline)"),
    "priority": PolicyConfig(
        "priority", use_priority=True, use_reoptimisation=False, use_coverage=False,
        use_opportunity_cost=False, use_deadline_term=True,
        label="+ explainable triage scoring"),
    "priority_opt": PolicyConfig(
        "priority_opt", use_priority=True, use_reoptimisation=True, use_coverage=False,
        use_opportunity_cost=True, use_deadline_term=True,
        label="+ exact batch re-optimisation"),
    "aegis": PolicyConfig(
        "aegis", label="AEGIS full (+ coverage-aware reserve protection)"),
}


@dataclass
class RunResult:
    policy: str
    label: str
    metrics: Dict[str, object]
    integrity_problems: List[str]
    epoch_reports: int
    decision_records: int

    def get(self, key: str, default=None):
        return self.metrics.get(key, default)


class Simulator:
    def __init__(self, scenario: Scenario, policy: PolicyConfig, seed: int = 4242,
                 verbose: bool = False) -> None:
        reset_id_sequences()
        self.scenario = scenario
        self.policy = policy
        self.rng = random.Random(seed)
        self.verbose = verbose

        self.metrics = Metrics()
        self.bus = EventBus(partitions=16, metrics=self.metrics)
        self.store = StateStore(lease_ttl_s=30.0, metrics=self.metrics)
        self.eta = TravelTimeService(cache_ttl_s=600.0, metrics=self.metrics)
        self.forecaster = DemandForecaster()
        self.coverage = CoverageModel(self.forecaster, min_free_per_region=2,
                                      penalty_weight=8.0)

        # Evaluation must be reproducible, so the epoch is bounded by work
        # done rather than by wall-clock time (see OptimizerConfig).
        cfg = OptimizerConfig(epoch_s=policy.epoch_s, deterministic_budget=True)
        if not policy.use_coverage:
            cfg.coverage_weight = 0.0
        if not policy.use_opportunity_cost:
            cfg.scarcity_weight = 0.0
            cfg.overqualification_weight = 0.0
        if not policy.use_deadline_term:
            cfg.late_weight = 0.0
        if not policy.use_priority:
            cfg.flat_priority = 50.0       # every call weighted identically
        self.engine = DispatchEngine(self.store, self.eta, self.coverage,
                                     self.metrics, self.bus, cfg, seed=seed + 1)

        self.now = 0.0
        self._q: List[Tuple[float, int, str, dict]] = []
        self._seq = 0
        self._reopt_pending = False
        self._last_reopt = -1e9

        self.hospitals: List[Resource] = []
        self.pending_fifo: List[str] = []            # baseline backfill queue
        self._scheduled: set = set()
        self.resolved: List[Incident] = []
        self.expired: List[Incident] = []
        self.helicopter_trips_low_severity = 0
        self.helicopter_trips = 0
        self.transport_diverted = 0
        self.transport_blocked = 0

        self.bus.subscribe("assignments.committed", lambda ev: None)
        self._boot()

    # ------------------------------------------------------------------

    def _push(self, t: float, kind: str, payload: dict) -> None:
        self._seq += 1
        heapq.heappush(self._q, (t, self._seq, kind, payload))

    def _boot(self) -> None:
        for fs in self.scenario.fleet:
            r = fs.build()
            self.store.put_resource(r)
            if r.resource_type == ResourceType.HOSPITAL:
                self.hospitals.append(r)
        self.engine.reindex()

        for idx, spec in enumerate(self.scenario.incidents):
            self._push(spec.t, "INCIDENT", {"idx": idx})
        for idx, ev in enumerate(self.scenario.env_events):
            self._push(ev.t, "ENV", {"idx": idx})

        if self.policy.use_reoptimisation:
            t = self.policy.epoch_s
            while t < self.scenario.horizon_s:
                self._push(t, "REOPT", {"scheduled": True})
                t += self.policy.epoch_s
        t = 60.0
        while t < self.scenario.horizon_s:
            self._push(t, "MAINTENANCE", {})
            t += 60.0

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    def run(self) -> RunResult:
        horizon = self.scenario.horizon_s
        while self._q:
            t, _, kind, payload = heapq.heappop(self._q)
            if t > horizon * 1.35:
                break
            self.now = t
            handler = getattr(self, f"_on_{kind.lower()}")
            handler(payload)
            self.bus.drain(budget=512)
            self.store.relay(lambda tp, k, p, ts: self.bus.publish(tp, k, p, ts))
        return self._finalise()

    # ------------------------------------------------------------------
    # Handlers
    # ------------------------------------------------------------------

    def _on_incident(self, payload: dict) -> None:
        spec = self.scenario.incidents[payload["idx"]]
        inc = spec.build()
        self.store.put_incident(inc)
        self.forecaster.observe(inc.region_id, self.now,
                                weight=1.0 + 0.25 * (inc.severity - 1))
        self.metrics.incr("incidents.received")

        if self.policy.use_priority:
            priority.rescore(inc, self.now)
        else:
            inc.priority = 50.0
            inc.priority_breakdown = {"_policy_version": "flat-fcfs"}

        self.bus.publish("incidents.raw", inc.region_id,
                         {"incident_id": inc.incident_id, "severity": inc.severity},
                         self.now)

        made = self.engine.assign_immediate(inc, self.now)
        for a in made:
            self._schedule_arrival(a)
        if inc.outstanding():
            self.pending_fifo.append(inc.incident_id)
            self._request_reopt()

        # Give up on an unattended incident well past its window so its
        # requirement slots stop competing for units that could still help
        # somebody reachable in time.
        self._push(inc.deadline + 1.5 * inc.time_window_s, "EXPIRY_CHECK",
                   {"incident_id": inc.incident_id})

    def _schedule_arrival(self, a: Assignment) -> None:
        if a.assignment_id in self._scheduled:
            return
        self._scheduled.add(a.assignment_id)
        self._push(a.arrive_at, "ARRIVE", {"assignment_id": a.assignment_id})

    def _on_arrive(self, payload: dict) -> None:
        a = self.store.assignments.get(payload["assignment_id"])
        if a is None or a.state != AssignmentState.COMMITTED:
            return                                   # revoked before arrival
        res = self.store.resources[a.resource_id]
        inc = self.store.incidents[a.incident_id]
        if not inc.is_open():
            self._release_resource(res, a, at=res.location)
            return

        a.state = AssignmentState.ARRIVED
        res.state = ResourceState.ON_SCENE
        res.location = inc.location
        self.engine.touch(res)

        if inc.first_arrival_at is None:
            inc.first_arrival_at = self.now
            rt = self.now - inc.reported_at
            self.metrics.observe("response.first_arrival_s", rt)
            self.metrics.observe(f"response.sev{inc.severity}_s", rt)
            self.metrics.observe("response.weighted_s", rt * inc.severity)
            if self.now > inc.deadline:
                self.metrics.incr("deadline.missed")
            else:
                self.metrics.incr("deadline.met")
        inc.state = IncidentState.IN_PROGRESS

        lo, hi = SERVICE_S[a.resource_type]
        scale = 1.0 + 0.16 * (inc.severity - 3)
        dur = self.rng.uniform(lo, hi) * max(0.6, scale)
        if a.resource_type == ResourceType.HELICOPTER:
            self.helicopter_trips += 1
            if inc.severity <= 3:
                self.helicopter_trips_low_severity += 1
        self._push(self.now + dur, "SERVICE_DONE", {"assignment_id": a.assignment_id})

    def _on_service_done(self, payload: dict) -> None:
        a = self.store.assignments.get(payload["assignment_id"])
        if a is None or a.state != AssignmentState.ARRIVED:
            return
        res = self.store.resources[a.resource_id]
        inc = self.store.incidents[a.incident_id]
        a.state = AssignmentState.COMPLETED
        if not payload.get("retry"):
            self.metrics.incr("assignments.completed")

        done = sum(1 for x in self.store.assignments.values()
                   if x.incident_id == inc.incident_id
                   and x.state == AssignmentState.COMPLETED)
        needed = sum(r.count for r in inc.requirements)
        if done >= needed and inc.is_open():
            inc.state = IncidentState.RESOLVED
            inc.resolved_at = self.now
            self.resolved.append(inc)
            self.metrics.incr("incidents.resolved")
            self.metrics.observe("resolution.total_s", self.now - inc.reported_at)

        if (a.resource_type == ResourceType.AMBULANCE
                and self.rng.random() < TRANSPORT_PROBABILITY):
            self._begin_transport(res, a, inc)
        else:
            self._release_resource(res, a, at=inc.location)

    def _begin_transport(self, res: Resource, a: Assignment, inc: Incident) -> None:
        hospital = self._reserve_bed(inc.location)
        if hospital is None:
            # Every reachable facility is saturated. The unit holds on scene,
            # which is exactly how bed shortage propagates back into fleet
            # availability in reality.
            self.transport_blocked += 1
            self.metrics.incr("transport.blocked_no_bed")
            self._push(self.now + self.rng.uniform(600, 1800), "SERVICE_DONE",
                       {"assignment_id": a.assignment_id, "retry": True})
            a.state = AssignmentState.ARRIVED
            return
        d = haversine_km(inc.location, hospital.location)
        if d > 25.0:
            self.transport_diverted += 1
            self.metrics.incr("transport.diverted")
        travel = self.eta.estimate(inc.location, hospital.location,
                                   ResourceType.AMBULANCE, res.speed_kmph,
                                   inc.hazard, self.now)
        res.state = ResourceState.TRANSPORTING
        self.metrics.observe("transport.travel_s", travel)
        self._push(self.now + travel, "TRANSPORT_DONE",
                   {"assignment_id": a.assignment_id, "hospital_id": hospital.resource_id})

    def _reserve_bed(self, near: GeoPoint) -> Optional[Resource]:
        """
        Atomic bed reservation via compare-and-swap on the hospital row.

        Capacity is a shared, contended resource exactly like a vehicle, so it
        goes through the same conflict-prevention mechanism rather than a
        read-then-write that can oversubscribe under load.
        """
        candidates = sorted(self.hospitals, key=lambda h: haversine_km(near, h.location))
        for h in candidates[:12]:
            if h.free_capacity() <= 0:
                continue
            try:
                self.store.update_resource(h.resource_id, h.version,
                                           lambda r: setattr(r, "occupied", r.occupied + 1))
                return h
            except Exception:                                   # CAS lost - try next
                continue
        return None

    def _on_transport_done(self, payload: dict) -> None:
        a = self.store.assignments.get(payload["assignment_id"])
        if a is None:
            return
        res = self.store.resources[a.resource_id]
        hospital = self.store.resources[payload["hospital_id"]]
        self._push(self.now + self.rng.uniform(*BED_OCCUPANCY_S), "BED_FREE",
                   {"hospital_id": hospital.resource_id})
        self._release_resource(res, a, at=hospital.location)

    def _on_bed_free(self, payload: dict) -> None:
        h = self.store.resources[payload["hospital_id"]]
        h.occupied = max(0, h.occupied - 1)
        h.version += 1

    def _release_resource(self, res: Resource, a: Optional[Assignment],
                          at: GeoPoint) -> None:
        if res.busy_since is not None:
            res.busy_seconds_total += max(0.0, self.now - res.busy_since)
        res.busy_since = None
        res.location = at
        res.state = ResourceState.AVAILABLE
        res.current_assignment = None
        res.version += 1
        self.engine.touch(res)
        if a is not None and a.state not in (AssignmentState.COMPLETED,
                                             AssignmentState.CANCELLED):
            a.state = AssignmentState.COMPLETED
        self._on_capacity_freed()

    def _on_capacity_freed(self) -> None:
        if self.policy.use_reoptimisation:
            self._request_reopt()
        else:
            self._backfill_fifo()

    # ------------------------------------------------------------------
    # Backfill for non-re-optimising policies (keeps the baseline honest)
    # ------------------------------------------------------------------

    def _backfill_fifo(self) -> None:
        if not self.pending_fifo:
            return
        order = self.pending_fifo
        if self.policy.use_priority:
            # With triage enabled the waiting queue is served worst-first;
            # without it, strictly first-come-first-served.
            for iid in order:
                inc = self.store.incidents.get(iid)
                if inc is not None:
                    priority.rescore(inc, self.now)
            order = sorted(order, key=lambda i: -(self.store.incidents[i].priority
                                                  if i in self.store.incidents else 0.0))
        still: List[str] = []
        for iid in order:
            inc = self.store.incidents.get(iid)
            if inc is None or not inc.is_open():
                continue
            if not inc.outstanding():
                continue
            made = self.engine.assign_immediate(inc, self.now)
            for a in made:
                self._schedule_arrival(a)
            if inc.outstanding():
                still.append(iid)
        self.pending_fifo = still

    # ------------------------------------------------------------------
    # Re-optimisation
    # ------------------------------------------------------------------

    def _request_reopt(self) -> None:
        """
        Debounced, event-driven re-optimisation.

        The problem statement asks for continuous re-optimisation on
        environment change. Running the solver on *every* change would be both
        wasteful and destabilising, so triggers are coalesced into at most one
        epoch per debounce window. This is the standard control-loop answer to
        a noisy input signal.
        """
        if not self.policy.use_reoptimisation or self._reopt_pending:
            return
        when = max(self.now + self.policy.reopt_debounce_s,
                   self._last_reopt + self.policy.reopt_debounce_s)
        self._reopt_pending = True
        self._push(when, "REOPT", {"triggered": True})

    def _on_reopt(self, payload: dict) -> None:
        if payload.get("triggered"):
            self._reopt_pending = False
        if not self.policy.use_reoptimisation:
            return
        rep = self.engine.reoptimize(self.now)
        self._last_reopt = self.now
        for a in self.store.assignments.values():
            if a.state == AssignmentState.COMMITTED and a.generation == self.engine.epoch:
                self._schedule_arrival(a)
        self.metrics.observe("reopt.slots", rep.slots)
        self.metrics.observe("reopt.candidates", rep.candidates)
        self.pending_fifo = [i for i in self.pending_fifo
                             if (inc := self.store.incidents.get(i)) and inc.outstanding()]

    # ------------------------------------------------------------------
    # Environment
    # ------------------------------------------------------------------

    def _on_env(self, payload: dict) -> None:
        ev = self.scenario.env_events[payload["idx"]]
        if ev.kind == "ROAD_CLOSURE":
            p = GeoPoint(float(ev.payload["lat"]), float(ev.payload["lon"]))
            cond = RoadCondition(cell=cell_of(p),
                                 multiplier=float(ev.payload["multiplier"]),
                                 until=self.now + float(ev.payload["duration_s"]),
                                 reason=str(ev.payload["reason"]))
            self.eta.apply_road_condition(cond)
            self.metrics.incr("env.road_closure")
            self.bus.publish("environment.events", "global",
                             {"kind": "ROAD_CLOSURE", "cell": str(cond.cell)}, self.now)
            self._request_reopt()

        elif ev.kind == "VEHICLE_FAILURE":
            pool = [r for r in self.store.resources.values()
                    if r.is_dispatchable() and r.state != ResourceState.OUT_OF_SERVICE]
            if not pool:
                return
            victim = pool[int(float(ev.payload["pick"]) * len(pool)) % len(pool)]
            live = self.store.live_assignment_of(victim.resource_id)
            if live is not None and live.is_revocable():
                self.engine._revoke(live, self.now, reason="vehicle_failure")
                inc = self.store.incidents.get(live.incident_id)
                if inc is not None and inc.is_open() and inc.outstanding():
                    if not self.policy.use_reoptimisation:
                        self.pending_fifo.append(inc.incident_id)
            elif live is not None:
                live.state = AssignmentState.CANCELLED
            victim.state = ResourceState.OUT_OF_SERVICE
            victim.current_assignment = None
            victim.busy_since = None
            victim.version += 1
            victim.failures += 1
            self.metrics.incr("env.vehicle_failure")
            self._push(self.now + float(ev.payload["duration_s"]), "REPAIR",
                       {"resource_id": victim.resource_id})
            self._request_reopt()

        elif ev.kind == "ROUTER_OUTAGE":
            self.eta.router_healthy = False
            self.metrics.incr("env.router_outage")
            self._push(self.now + float(ev.payload["duration_s"]), "ROUTER_UP", {})

    def _on_router_up(self, payload: dict) -> None:
        self.eta.router_healthy = True

    def _on_repair(self, payload: dict) -> None:
        r = self.store.resources[payload["resource_id"]]
        if r.state == ResourceState.OUT_OF_SERVICE:
            r.state = ResourceState.AVAILABLE
            r.location = r.home_base
            r.version += 1
            self.engine.touch(r)
            self._on_capacity_freed()

    def _on_maintenance(self, payload: dict) -> None:
        self.eta.expire_conditions(self.now)
        self.store.reap_expired_leases(self.now)
        self.metrics.gauge("bus.lag", self.bus.lag())
        free = sum(1 for r in self.store.resources.values()
                   if r.is_dispatchable() and r.is_free())
        self.metrics.observe("fleet.free_units", free)
        if self.policy.use_coverage:
            idle = [r for r in self.store.resources.values()
                    if r.is_dispatchable() and r.is_free()]
            targets = self.coverage.relocation_targets(idle, REGIONS, self.now)
            for rid, tgt in list(targets.items())[:6]:
                r = self.store.resources[rid]
                # Drift toward the under-covered centroid rather than teleport;
                # a relocating unit is still dispatchable en route.
                r.location = GeoPoint(r.location.lat + 0.18 * (tgt.lat - r.location.lat),
                                      r.location.lon + 0.18 * (tgt.lon - r.location.lon))
                r.version += 1
                self.engine.touch(r)
                self.metrics.incr("coverage.relocations")

    def _on_expiry_check(self, payload: dict) -> None:
        inc = self.store.incidents.get(payload["incident_id"])
        if inc is None or not inc.is_open():
            return
        if inc.first_arrival_at is not None:
            return
        inc.state = IncidentState.EXPIRED
        self.expired.append(inc)
        self.metrics.incr("incidents.expired")
        for a in self.store.live_assignments_for(inc.incident_id):
            self.engine._revoke(a, self.now, reason="incident_expired")

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------

    def _finalise(self) -> RunResult:
        end = self.now
        for r in self.store.resources.values():
            if r.busy_since is not None:
                r.busy_seconds_total += max(0.0, end - r.busy_since)

        dispatchable = [r for r in self.store.resources.values() if r.is_dispatchable()]
        util = (sum(r.busy_seconds_total for r in dispatchable)
                / max(1e-9, len(dispatchable) * max(end, 1.0)))

        received = int(self.metrics.counter("incidents.received"))
        resolved = int(self.metrics.counter("incidents.resolved"))
        expired = int(self.metrics.counter("incidents.expired"))
        met = int(self.metrics.counter("deadline.met"))
        missed = int(self.metrics.counter("deadline.missed"))
        never = received - met - missed

        h = self.metrics.hist("response.first_arrival_s")
        hw = self.metrics.hist("response.weighted_s")
        t1 = self.metrics.hist("t1.latency_ms")
        t2 = self.metrics.hist("t2.solve_ms")

        sev_stats = {}
        for s in range(1, 6):
            hh = self.metrics.hist(f"response.sev{s}_s")
            if len(hh):
                sev_stats[f"sev{s}_mean_min"] = round(hh.mean() / 60.0, 2)
                sev_stats[f"sev{s}_p90_min"] = round(hh.quantile(0.90) / 60.0, 2)
                sev_stats[f"sev{s}_n"] = len(hh)

        m: Dict[str, object] = {
            "incidents_received": received,
            "incidents_resolved": resolved,
            "incidents_expired": expired,
            "unserved_rate_pct": round(100.0 * (received - met - missed) / max(1, received), 2),
            "reached_rate_pct": round(100.0 * (met + missed) / max(1, received), 2),
            "deadline_met_pct": round(100.0 * met / max(1, met + missed + never), 2),
            "deadline_missed": missed,
            "never_reached": never,
            "response_mean_min": round(h.mean() / 60.0, 2) if len(h) else float("nan"),
            "response_p50_min": round(h.quantile(0.50) / 60.0, 2) if len(h) else float("nan"),
            "response_p90_min": round(h.quantile(0.90) / 60.0, 2) if len(h) else float("nan"),
            "response_p99_min": round(h.quantile(0.99) / 60.0, 2) if len(h) else float("nan"),
            "severity_weighted_mean_min": round(hw.mean() / 60.0, 2) if len(hw) else float("nan"),
            "utilisation_pct": round(100.0 * util, 2),
            "assignments_committed": int(self.metrics.counter("assignments.committed")),
            "reassignments": self.engine.reassignments,
            "reassignment_rate_pct": round(
                100.0 * self.engine.reassignments
                / max(1, int(self.metrics.counter("assignments.committed"))), 2),
            "commit_denied": int(self.metrics.counter("commit.denied")),
            "double_book_attempts_blocked": self.store.double_book_attempts,
            "helicopter_trips": self.helicopter_trips,
            "helicopter_low_severity_pct": round(
                100.0 * self.helicopter_trips_low_severity / max(1, self.helicopter_trips), 2),
            "transport_blocked_no_bed": self.transport_blocked,
            "transport_diverted": self.transport_diverted,
            "t1_latency_p99_ms": round(t1.quantile(0.99), 3) if len(t1) else float("nan"),
            "t1_latency_mean_ms": round(t1.mean(), 3) if len(t1) else float("nan"),
            "t2_solve_p99_ms": round(t2.quantile(0.99), 2) if len(t2) else float("nan"),
            "t2_solve_mean_ms": round(t2.mean(), 2) if len(t2) else float("nan"),
            "eta_cache_hit_rate_pct": round(100.0 * self.eta.cache.stats()["hit_rate"], 2),
            "eta_degraded_calls": self.eta.degraded_calls,
            "circuit_breaker_trips": self.eta.breaker.trips,
            "bus_published": self.bus.published,
            "bus_dlq": len(self.bus.dlq),
            "lease_expiries_reclaimed": self.store.lease_expiries,
            "road_closures": int(self.metrics.counter("env.road_closure")),
            "vehicle_failures": int(self.metrics.counter("env.vehicle_failure")),
            "coverage_relocations": int(self.metrics.counter("coverage.relocations")),
            **sev_stats,
        }
        return RunResult(policy=self.policy.name, label=self.policy.label, metrics=m,
                         integrity_problems=self.store.integrity_check(),
                         epoch_reports=len(self.engine.reports),
                         decision_records=len(self.store.decision_log))
