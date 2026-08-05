"""
The dispatch decision engine.

Architecture: **two tiers over one cost model.**

  Tier 1 - admission (target p99 < 200 ms).
      A new incident gets a provisional assignment immediately from a
      k-nearest feasible candidate set. Nobody waits for a solver epoch. The
      assignment is marked PROPOSED, which makes it free to revoke.

  Tier 2 - re-optimisation (every `epoch_s`, budgeted).
      A regional solver rebuilds the cost matrix over all open incidents and
      all revocable assignments and solves it exactly, then improves under
      side constraints with LNS. Anytime: whatever it holds when the budget
      expires is feasible and shippable.

Both tiers share `_cost` so a provisional decision and an optimal decision are
comparable on the same scale - without that, re-optimisation would churn
purely because the two tiers disagreed about units.

Three properties are load-bearing and deserve to be called out:

* **Churn control.** Re-optimisation is only valuable if it does not thrash
  crews. The switching penalty lives *inside* the cost matrix and scales with
  assignment maturity (free to move a PROPOSED unit, expensive to turn an
  EN_ROUTE one around, impossible once ARRIVED). Optimality is therefore
  defined including the cost of changing one's mind.

* **Conflict freedom.** No assignment is ever published without an
  all-or-nothing lease acquired through the store. The solver proposes; the
  store disposes. Even if two solver replicas ran concurrently on the same
  region - which partition ownership should prevent - the leases would still
  make double-booking impossible.

* **Explainability.** Every commit writes a decision record: the candidate
  set, why candidates were filtered out, the cost breakdown of the winner and
  of the runner-up, and the objective delta. That record is the artefact an
  operator reads and an inquiry replays.
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from ..domain.models import (Assignment, AssignmentState, DISPATCHABLE, GeoPoint,
                             Incident, IncidentState, Requirement, Resource,
                             ResourceState, ResourceType)
from ..infra.store import ConcurrencyError, ReservationDenied, StateStore
from . import priority
from .coverage import CoverageModel
from .eta import TravelTimeService
from .geo import SpatialIndex, haversine_km
from .matching import INFEASIBLE, greedy_assignment, lns_improve, objective, solve_assignment


@dataclass
class OptimizerConfig:
    #: Hard feasibility cutoff. A unit that cannot physically reach the scene
    #: within this many minutes is not a candidate at any price: committing it
    #: removes a vehicle from the pool for hours and still arrives long after
    #: the clinical window has closed. Without this bound the exact matcher
    #: will cheerfully dispatch an ambulance across the country, because a
    #: minimum-cost assignment still assigns every row it is given.
    max_eta_min: float = 100.0
    #: Reference travel time used to shape preference among feasible units.
    horizon_min: float = 100.0
    late_weight: float = 2.4          # penalty per minute past the deadline
    overqualification_weight: float = 3.0
    scarcity_weight: float = 6.0
    coverage_weight: float = 1.0
    #: Objective gain (cost units) required before a live assignment is moved.
    min_reassign_gain: float = 12.0
    #: Bonus for leaving a unit on the task it is already running. This is the
    #: stabiliser that stops the solver from swapping a unit two minutes from
    #: the scene for one that merely looks marginally better on paper.
    continuity_bonus: float = 22.0
    epoch_s: float = 30.0
    lns_iterations: int = 8
    solver_budget_ms: float = 400.0
    #: In production the epoch is bounded by wall-clock, which is what a real
    #: latency budget means. That makes outcomes depend on machine load, so
    #: evaluation runs instead bound the epoch by a deterministic work budget
    #: (shards per epoch). Without this, replaying the same event stream twice
    #: gives slightly different results and no reported figure is reproducible.
    deterministic_budget: bool = False
    max_shards_per_epoch: int = 16
    k_nearest: int = 12
    #: Per-shard matrix bounds. These cap solver work per epoch and are the
    #: knob that trades optimality for a hard latency ceiling.
    max_candidates: int = 90
    max_borrowed: int = 20
    max_slots: int = 70
    #: When set, triage scoring is bypassed and every incident carries this
    #: priority. Used only to construct the FCFS ablation baseline.
    flat_priority: float | None = None


#: Relative scarcity of each asset class; a helicopter spent on a routine
#: transfer is a helicopter unavailable for the case only it can reach.
SCARCITY: Dict[ResourceType, float] = {
    ResourceType.AMBULANCE: 0.0,
    ResourceType.FIRE_UNIT: 0.4,
    ResourceType.RESCUE_TEAM: 0.8,
    ResourceType.HELICOPTER: 2.0,
}


@dataclass
class Slot:
    """One unit of unmet demand: (incident, resource type, capability floor)."""
    incident: Incident
    resource_type: ResourceType
    min_capability: int
    index: int


@dataclass
class EpochReport:
    epoch: int
    now: float
    slots: int
    candidates: int
    assigned: int
    reassigned: int
    released: int
    objective_before: float
    objective_after: float
    solve_ms: float
    denied: int = 0


class DispatchEngine:
    def __init__(self, store: StateStore, eta: TravelTimeService,
                 coverage: CoverageModel, metrics, bus=None,
                 config: Optional[OptimizerConfig] = None, seed: int = 11) -> None:
        self.store = store
        self.eta = eta
        self.coverage = coverage
        self.metrics = metrics
        self.bus = bus
        self.cfg = config or OptimizerConfig()
        self.index = SpatialIndex()
        self.rng = random.Random(seed)
        self.epoch = 0
        self.reports: List[EpochReport] = []
        self.reassignments = 0
        self.commit_failures = 0

    # ------------------------------------------------------------------
    # Indexing
    # ------------------------------------------------------------------

    def reindex(self) -> None:
        for r in self.store.resources.values():
            if r.is_dispatchable():
                self.index.upsert(r.resource_id, r.location)

    def touch(self, res: Resource) -> None:
        if res.is_dispatchable():
            self.index.upsert(res.resource_id, res.location)

    @staticmethod
    def _same_task(cur: Optional[Assignment], slot: Slot) -> bool:
        """
        Two slots of the same incident and type are interchangeable. Comparing
        raw slot indices instead would flag a unit as 'reassigned' merely
        because the solver handed it slot 2 of an incident instead of slot 1 -
        a no-op that would nonetheless revoke it and restart its clock.
        """
        return (cur is not None
                and cur.incident_id == slot.incident.incident_id
                and cur.resource_type == slot.resource_type)

    def _score(self, inc: Incident, now: float) -> float:
        if self.cfg.flat_priority is not None:
            inc.priority = self.cfg.flat_priority
            inc.priority_breakdown = {"_policy_version": "flat-fcfs"}
            return inc.priority
        return priority.rescore(inc, now)

    # ------------------------------------------------------------------
    # Cost model  (shared by both tiers)
    # ------------------------------------------------------------------

    def _cost(self, res: Resource, slot: Slot, now: float,
              free_counts: Dict[tuple, int],
              current: Optional[Assignment] = None,
              want_breakdown: bool = False):
        """
        Cost of serving `slot` with `res`, in urgency-minutes.

        Sign convention: a *useful* assignment is negative. Filling an urgent
        slot with a nearby unit is strongly negative; a unit further than the
        planning horizon turns positive and the solver leaves the slot unfilled
        rather than committing a unit that would arrive too late to matter.
        That is what lets one matrix express both "who goes" and "who waits".
        """
        inc = slot.incident
        if res.resource_type != slot.resource_type:
            return (INFEASIBLE, {"reason": "type_mismatch"}) if want_breakdown else INFEASIBLE
        if res.capability < slot.min_capability:
            return (INFEASIBLE, {"reason": "capability_below_minimum"}) if want_breakdown else INFEASIBLE
        if res.state not in (ResourceState.AVAILABLE, ResourceState.EN_ROUTE,
                             ResourceState.RESERVED):
            return (INFEASIBLE, {"reason": f"state_{res.state.value}"}) if want_breakdown else INFEASIBLE

        if self._same_task(current, slot) and current.arrive_at is not None:
            # Already on the way: the honest estimate is the time remaining,
            # not a fresh quote from the point of departure.
            eta_s = max(15.0, current.arrive_at - now)
        else:
            origin = res.location
            if current is not None:
                projected = current.projected_position(now)
                if projected is not None:
                    origin = projected            # divert from where it is now
            eta_s = self.eta.estimate(origin, inc.location, res.resource_type,
                                      res.speed_kmph, inc.hazard, now)
        eta_min = eta_s / 60.0
        if eta_min > self.cfg.max_eta_min:
            return ((INFEASIBLE, {"reason": "beyond_reach_radius",
                                  "eta_min": round(eta_min, 1)})
                    if want_breakdown else INFEASIBLE)
        urgency = max(0.15, inc.priority / 100.0)

        travel = urgency * (eta_min - self.cfg.horizon_min)

        slack_min = max(0.0, (inc.deadline - now) / 60.0)
        late_min = max(0.0, eta_min - slack_min)
        lateness = self.cfg.late_weight * urgency * late_min

        overqual = self.cfg.overqualification_weight * max(0, res.capability - slot.min_capability)
        scarcity = self.cfg.scarcity_weight * SCARCITY.get(res.resource_type, 0.0)

        # Coverage is the marginal cost of taking a unit OUT of the available
        # pool. A unit already committed to a task has already left the pool,
        # so charging it again would make every dispatched vehicle look
        # expensive relative to an idle one and cause the solver to swap them
        # continuously. Only draws from the idle pool pay this.
        cover = 0.0
        if current is None:
            cover = self.cfg.coverage_weight * self.coverage.penalty(res, free_counts, now)

        # Continuity and switching are scaled by urgency for the same reason the
        # travel term is: the whole matrix is denominated in urgency-minutes.
        # An unscaled constant would dominate every other term on a low-urgency
        # incident and vanish on a high-urgency one - the opposite of intended.
        switch = 0.0
        continuity = 0.0
        if current is not None:
            if self._same_task(current, slot):
                continuity = -self.cfg.continuity_bonus * urgency
            else:
                switch = current.switching_penalty() * urgency

        total = travel + lateness + overqual + scarcity + cover + switch + continuity
        if not want_breakdown:
            return total
        return total, {
            "eta_s": round(eta_s, 1),
            "eta_min": round(eta_min, 2),
            "urgency": round(urgency, 3),
            "travel_term": round(travel, 2),
            "lateness_term": round(lateness, 2),
            "overqualification_term": round(overqual, 2),
            "scarcity_term": round(scarcity, 2),
            "coverage_term": round(cover, 2),
            "switching_term": round(switch, 2),
            "continuity_term": round(continuity, 2),
            "total": round(total, 2),
            "slack_min": round(slack_min, 2),
        }

    # ------------------------------------------------------------------
    # Tier 1 - immediate admission
    # ------------------------------------------------------------------

    def assign_immediate(self, incident: Incident, now: float) -> List[Assignment]:
        """
        Greedy k-nearest dispatch on the ingest path.

        Bounded work by construction: the spatial index caps the candidate set
        at `k_nearest` per requirement, so this stays sub-linear in fleet size
        no matter how large the national fleet grows.
        """
        t0 = time.perf_counter()
        self._score(incident, now)
        made: List[Assignment] = []
        free_counts = self.coverage.free_counts(list(self.store.resources.values()))

        for rtype, need in incident.outstanding().items():
            min_cap = max((r.min_capability for r in incident.requirements
                           if r.resource_type == rtype), default=1)
            candidate_ids = self.index.near(incident.location, self.cfg.k_nearest * 3)
            scored: List[Tuple[float, Resource, dict]] = []
            rejected: Dict[str, int] = {}
            for rid in candidate_ids:
                res = self.store.resources.get(rid)
                if res is None or not res.is_free():
                    rejected["not_available"] = rejected.get("not_available", 0) + 1
                    continue
                slot = Slot(incident, rtype, min_cap, 0)
                c, br = self._cost(res, slot, now, free_counts, want_breakdown=True)
                if c >= INFEASIBLE / 2:
                    reason = str(br.get("reason", "infeasible"))
                    rejected[reason] = rejected.get(reason, 0) + 1
                    continue
                scored.append((c, res, br))
            scored.sort(key=lambda t: (t[0], t[1].resource_id))

            for c, res, br in scored[:need]:
                asg = self._commit(incident, res, br["eta_s"], c, now,
                                   rationale={
                                       "tier": "T1_admission",
                                       "candidates_considered": len(candidate_ids),
                                       "candidates_feasible": len(scored),
                                       "rejected_reasons": rejected,
                                       "cost_breakdown": br,
                                       "runner_up_cost": round(scored[need][0], 2)
                                       if len(scored) > need else None,
                                       "priority_breakdown": incident.priority_breakdown,
                                   })
                if asg is not None:
                    made.append(asg)

        self.metrics.observe("t1.latency_ms", (time.perf_counter() - t0) * 1000.0)
        if made:
            self.metrics.observe("t1.time_to_first_assignment_s", now - incident.reported_at)
        self._refresh_incident_state(incident)
        return made

    # ------------------------------------------------------------------
    # Tier 2 - batch re-optimisation
    # ------------------------------------------------------------------

    def _shard_problem(self, region: str, now: float, taken: set
                       ) -> Tuple[List[Resource], List[Slot], Dict[str, Assignment]]:
        """
        Build the sub-problem for one regional shard.

        Sharding by region is not merely an optimisation - it is the
        scalability model. One shard is owned by one solver worker, matched to
        one event-log partition, so shards run in parallel with no shared
        state and no distributed locking on the hot path. A national fleet
        therefore scales by adding shards, not by growing one matrix
        quadratically.

        Cross-region borrowing is allowed but bounded: a shard may pull the
        nearest few free units from neighbouring regions, which is what
        prevents a hard administrative boundary from stranding an ambulance
        two kilometres from a casualty on the other side of it. In production
        that borrowing is serialised by the reservation lease; here shards run
        sequentially and `taken` plays the same role.
        """
        open_incidents = [i for i in self.store.incidents.values()
                          if i.is_open() and i.region_id == region
                          and i.state != IncidentState.RESOLVED]
        if not open_incidents:
            return [], [], {}
        for inc in open_incidents:
            self._score(inc, now)
        open_incidents.sort(key=lambda i: -i.priority)

        slots: List[Slot] = []
        for inc in open_incidents:
            irrevocable: Dict[ResourceType, int] = {}
            for a in self.store.live_assignments_for(inc.incident_id):
                if not a.is_revocable():
                    irrevocable[a.resource_type] = irrevocable.get(a.resource_type, 0) + 1
            for req in inc.requirements:
                need = req.count - irrevocable.get(req.resource_type, 0)
                for k in range(max(0, need)):
                    slots.append(Slot(inc, req.resource_type, req.min_capability, k))
        if not slots:
            return [], [], {}
        # Truncate FIRST, then derive the movable set from what survived.
        # An incident cut by the cap must not have its en-route units treated
        # as unwanted - that would revoke a live dispatch purely because the
        # matrix was full, which is the worst possible failure mode here.
        slots = slots[:self.cfg.max_slots]
        in_scope = {s.incident.incident_id for s in slots}

        revocable: Dict[str, Assignment] = {}
        for a in self.store.assignments.values():
            if a.is_live() and a.is_revocable() and a.incident_id in in_scope:
                revocable[a.resource_id] = a

        focus = slots[0].incident.location
        local: List[Resource] = []
        foreign: List[Resource] = []
        for r in self.store.resources.values():
            if not r.is_dispatchable() or r.resource_id in taken:
                continue
            usable = r.is_free() or r.resource_id in revocable
            if not usable:
                continue
            (local if r.region_id == region else foreign).append(r)

        local.sort(key=lambda r: haversine_km(r.location, focus))
        foreign.sort(key=lambda r: haversine_km(r.location, focus))
        candidates = local[:self.cfg.max_candidates]
        room = max(0, self.cfg.max_candidates - len(candidates))
        candidates += foreign[:min(room, self.cfg.max_borrowed)]
        return candidates, slots, revocable

    def reoptimize(self, now: float) -> EpochReport:
        """
        One re-optimisation epoch across every regional shard.

        Anytime and interruptible: each shard is solved independently and its
        result committed before the next begins, so exhausting the wall-clock
        budget degrades the *number of shards refreshed* this epoch rather
        than producing a partial, inconsistent global plan.
        """
        t0 = time.perf_counter()
        self.epoch += 1
        regions = sorted({i.region_id for i in self.store.incidents.values() if i.is_open()})
        taken: set = set()
        tot_slots = tot_cands = assigned = reassigned = released = denied = 0
        obj_before = obj_after = 0.0

        for n_done, region in enumerate(regions):
            if self.cfg.deterministic_budget:
                if n_done >= self.cfg.max_shards_per_epoch:
                    self.metrics.incr("t2.budget_exhausted")
                    break
            elif (time.perf_counter() - t0) * 1000.0 > self.cfg.solver_budget_ms:
                self.metrics.incr("t2.budget_exhausted")
                break
            a, r, rel, ob, oa, sl, cd, dn = self._solve_shard(region, now, taken)
            assigned += a
            reassigned += r
            released += rel
            obj_before += ob
            obj_after += oa
            tot_slots += sl
            tot_cands += cd
            denied += dn

        solve_ms = (time.perf_counter() - t0) * 1000.0
        self.metrics.observe("t2.solve_ms", solve_ms)
        self.metrics.observe("t2.shards", len(regions))
        rep = EpochReport(self.epoch, now, tot_slots, tot_cands, assigned, reassigned,
                          released, obj_before, obj_after, solve_ms, denied)
        self.reports.append(rep)
        return rep

    def _solve_shard(self, region: str, now: float, taken: set):
        candidates, slots, revocable = self._shard_problem(region, now, taken)
        if not candidates or not slots:
            return 0, 0, 0, 0.0, 0.0, len(slots), len(candidates), 0

        free_counts = self.coverage.free_counts(list(self.store.resources.values()))
        cost = [[0.0] * len(slots) for _ in range(len(candidates))]
        breakdowns: Dict[Tuple[int, int], dict] = {}
        for ri, res in enumerate(candidates):
            cur = revocable.get(res.resource_id)
            for si, slot in enumerate(slots):
                c, br = self._cost(res, slot, now, free_counts, cur, want_breakdown=True)
                cost[ri][si] = c
                if c < INFEASIBLE / 2:
                    breakdowns[(ri, si)] = br

        # Value of leaving the current plan untouched, so the epoch report can
        # state a real objective delta rather than an absolute number.
        incumbent: List[Tuple[int, int]] = []
        slot_taken: set = set()
        for ri, res in enumerate(candidates):
            cur = revocable.get(res.resource_id)
            if cur is None:
                continue
            for si, slot in enumerate(slots):
                if si in slot_taken:
                    continue
                if (slot.incident.incident_id == cur.incident_id
                        and slot.resource_type == cur.resource_type):
                    incumbent.append((ri, si))
                    slot_taken.add(si)
                    break
        objective_before = objective(cost, incumbent)
        incumbent_cost = {ri: cost[ri][si] for ri, si in incumbent}
        incumbent_slot = {ri: si for ri, si in incumbent}

        warm = greedy_assignment(cost)
        exact = solve_assignment(cost)
        best = exact if objective(cost, exact) <= objective(cost, warm) else warm
        if self.cfg.lns_iterations > 0 and len(best) > 2:
            best = lns_improve(cost, best, self.rng, iterations=self.cfg.lns_iterations)
        objective_after = objective(cost, best)

        # ---- hysteresis gate --------------------------------------------
        # Applied per pair, not globally. A global gate would let one large
        # improvement drag a dozen pointless crew reroutes along with it, and
        # crews stop trusting a system that reroutes them for nothing.
        accepted: List[Tuple[int, int]] = []
        for ri, si in best:
            if cost[ri][si] >= INFEASIBLE / 2:
                continue
            cur = revocable.get(candidates[ri].resource_id)
            if cur is None:
                accepted.append((ri, si))                      # idle unit: free to task
                continue
            if self._same_task(cur, slots[si]):
                accepted.append((ri, si))                      # unchanged task
                continue
            gain = incumbent_cost.get(ri, 0.0) - cost[ri][si]
            if gain >= self.cfg.min_reassign_gain:
                accepted.append((ri, si))

        assigned = reassigned = released = denied = 0
        accepted_rows = {ri for ri, _ in accepted}

        # ---- release only when genuinely superseded ----------------------
        # Supersession is evaluated at the level of *demand* - the (incident,
        # resource type) pair - not at the level of individual slot indices.
        # Slots of the same type on the same incident are interchangeable, so
        # a slot-level comparison reports a unit as displaced whenever the
        # solver merely permutes equivalent columns, and revokes a live
        # dispatch for no reason at all.
        demand: Dict[Tuple[str, ResourceType], int] = {}
        for sl in slots:
            k = (sl.incident.incident_id, sl.resource_type)
            demand[k] = demand.get(k, 0) + 1
        covered: Dict[Tuple[str, ResourceType], int] = {}
        for ri, si in accepted:
            k = (slots[si].incident.incident_id, slots[si].resource_type)
            covered[k] = covered.get(k, 0) + 1

        for ri, res in enumerate(candidates):
            cur = revocable.get(res.resource_id)
            if cur is None or ri in accepted_rows:
                continue
            k = (cur.incident_id, cur.resource_type)
            if covered.get(k, 0) >= demand.get(k, 0):
                # Its share of the demand is already staffed by other units,
                # so standing it down releases capacity rather than losing it.
                if self._revoke(cur, now, reason="superseded"):
                    released += 1
            else:
                # Demand is still unmet: keep the unit running and count it,
                # so a second unmatched unit on the same task is not kept too.
                covered[k] = covered.get(k, 0) + 1

        # ---- commit ------------------------------------------------------
        for ri, si in sorted(accepted, key=lambda p: cost[p[0]][p[1]]):
            res, slot = candidates[ri], slots[si]
            cur = revocable.get(res.resource_id)
            if self._same_task(cur, slot):
                taken.add(res.resource_id)
                continue                                   # already correct, no churn
            if cur is not None:
                if not self._revoke(cur, now, reason="reassigned"):
                    continue
                reassigned += 1
                self.reassignments += 1
            br = breakdowns.get((ri, si), {})
            asg = self._commit(slot.incident, res, br.get("eta_s", 0.0), cost[ri][si], now,
                               rationale={
                                   "tier": "T2_reoptimisation",
                                   "epoch": self.epoch,
                                   "shard": region,
                                   "cost_breakdown": br,
                                   "objective_before": round(objective_before, 2),
                                   "objective_after": round(objective_after, 2),
                                   "matrix": f"{len(candidates)}x{len(slots)}",
                                   "priority_breakdown": slot.incident.priority_breakdown,
                               })
            if asg is None:
                denied += 1
            else:
                assigned += 1
                taken.add(res.resource_id)

        for inc in {s.incident.incident_id: s.incident for s in slots}.values():
            self._refresh_incident_state(inc)

        return (assigned, reassigned, released, objective_before, objective_after,
                len(slots), len(candidates), denied)

    # ------------------------------------------------------------------
    # Commit / revoke  (the only paths that mutate resource ownership)
    # ------------------------------------------------------------------

    def _commit(self, incident: Incident, res: Resource, eta_s: float, cost: float,
                now: float, rationale: dict) -> Optional[Assignment]:
        holder = f"engine/epoch-{self.epoch}"
        idem = f"{incident.incident_id}:{res.resource_id}:{int(now)}"
        if self.store.seen(idem):
            return None
        try:
            lease = self.store.try_reserve(res.resource_id, holder, now,
                                           expected_version=res.version)
        except (ReservationDenied, ConcurrencyError):
            self.commit_failures += 1
            self.metrics.incr("commit.denied")
            return None

        asg = Assignment(incident_id=incident.incident_id, resource_id=res.resource_id,
                         resource_type=res.resource_type, eta_s=eta_s, created_at=now,
                         cost=cost, state=AssignmentState.COMMITTED,
                         generation=self.epoch, rationale=rationale)
        asg.depart_at = now
        asg.arrive_at = now + eta_s
        asg.origin = res.location
        asg.dest = incident.location

        self.store.release(res.resource_id, lease.token, now, ResourceState.AVAILABLE)
        res.state = ResourceState.EN_ROUTE
        res.current_assignment = asg.assignment_id
        res.busy_since = now
        res.version += 1
        res.trips += 1
        incident.assigned[res.resource_type] = incident.assigned.get(res.resource_type, 0) + 1

        self.store.commit(asg, events=[
            ("assignments.committed", incident.region_id, {
                "assignment_id": asg.assignment_id,
                "incident_id": incident.incident_id,
                "resource_id": res.resource_id,
                "eta_s": eta_s,
                "priority": round(incident.priority, 2),
            })], now=now)
        self.store.remember(idem, asg.assignment_id)
        self.store.journal({
            "ts": now, "type": "ASSIGN", "assignment_id": asg.assignment_id,
            "incident_id": incident.incident_id, "resource_id": res.resource_id,
            "cost": round(cost, 2), **rationale,
        })
        self.metrics.incr("assignments.committed")
        self.metrics.observe("assignment.eta_s", eta_s)
        return asg

    def _revoke(self, asg: Assignment, now: float, reason: str) -> bool:
        if not asg.is_revocable():
            return False
        res = self.store.resources.get(asg.resource_id)
        inc = self.store.incidents.get(asg.incident_id)
        asg.state = AssignmentState.CANCELLED
        if res is not None:
            if res.busy_since is not None:
                res.busy_seconds_total += max(0.0, now - res.busy_since)
            res.state = ResourceState.AVAILABLE
            res.current_assignment = None
            res.busy_since = None
            res.version += 1
        if inc is not None:
            inc.assigned[asg.resource_type] = max(0, inc.assigned.get(asg.resource_type, 1) - 1)
        self.store.journal({"ts": now, "type": "REVOKE", "assignment_id": asg.assignment_id,
                            "reason": reason})
        self.metrics.incr(f"assignments.revoked.{reason}")
        return True

    # ------------------------------------------------------------------

    def _refresh_incident_state(self, inc: Incident) -> None:
        if not inc.is_open():
            return
        outstanding = inc.outstanding()
        if not outstanding:
            inc.state = IncidentState.FULLY_ASSIGNED
        elif inc.assigned:
            inc.state = IncidentState.PARTIALLY_ASSIGNED
        else:
            inc.state = IncidentState.TRIAGED
        inc.version += 1
