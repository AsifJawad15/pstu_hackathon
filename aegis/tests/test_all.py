"""
Test suite for the AEGIS decision core.

The emphasis is on the properties that are hard requirements in the problem
statement and cheap to get wrong: exactness of the matcher, freedom from
resource conflicts under concurrency, correct degradation when a dependency
fails, and monotonicity of the triage model.

    python -m pytest tests -q     (or)     python tests/test_all.py
"""
from __future__ import annotations

import os
import random
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from aegis.core import priority
from aegis.core.coverage import CoverageModel, DemandForecaster
from aegis.core.eta import RoadCondition, TravelTimeService
from aegis.core.geo import SpatialIndex, cell_of, haversine_km
from aegis.core.matching import (INFEASIBLE, greedy_assignment, hungarian,
                                 lns_improve, objective, solve_assignment)
from aegis.core.optimizer import DispatchEngine, OptimizerConfig
from aegis.domain.models import (GeoPoint, HazardClass, Incident, Requirement,
                                 Resource, ResourceState, ResourceType)
from aegis.infra.cache import VersionedTTLCache
from aegis.infra.circuit_breaker import CircuitBreaker, CircuitOpen
from aegis.infra.event_bus import EventBus
from aegis.infra.metrics import Metrics
from aegis.infra.store import ConcurrencyError, ReservationDenied, StateStore


# ==========================================================================
# Matching
# ==========================================================================

def test_hungarian_matches_brute_force():
    """Exactness, checked against exhaustive enumeration on small instances."""
    import itertools
    rng = random.Random(1)
    for _ in range(60):
        n, m = rng.randint(1, 5), rng.randint(1, 5)
        cost = [[rng.uniform(-50, 50) for _ in range(m)] for _ in range(n)]
        got = objective(cost, hungarian(cost))
        k = min(n, m)
        best = min(
            sum(cost[r][c] for r, c in zip(rows, cols))
            for rows in itertools.permutations(range(n), k)
            for cols in itertools.permutations(range(m), k))
        assert abs(got - best) < 1e-6, f"{got} != {best}"


def test_hungarian_never_worse_than_greedy():
    rng = random.Random(2)
    for _ in range(40):
        n, m = rng.randint(3, 12), rng.randint(3, 12)
        cost = [[rng.uniform(-100, 20) for _ in range(m)] for _ in range(n)]
        assert objective(cost, hungarian(cost)) <= objective(cost, greedy_assignment(cost)) + 1e-9


def test_infeasible_pairs_are_dropped():
    cost = [[INFEASIBLE, -5.0], [-3.0, INFEASIBLE]]
    pairs = solve_assignment(cost)
    assert set(pairs) == {(0, 1), (1, 0)}
    cost2 = [[INFEASIBLE, INFEASIBLE]]
    assert solve_assignment(cost2) == []


def test_lns_never_degrades_incumbent():
    rng = random.Random(3)
    for _ in range(20):
        n, m = 8, 10
        cost = [[rng.uniform(-60, 40) for _ in range(m)] for _ in range(n)]
        inc = greedy_assignment(cost)
        out = lns_improve(cost, inc, rng, iterations=25)
        assert objective(cost, out) <= objective(cost, inc) + 1e-9


def test_rectangular_both_orientations():
    rng = random.Random(4)
    cost = [[rng.uniform(-10, 10) for _ in range(3)] for _ in range(7)]
    pairs = hungarian(cost)
    assert len(pairs) == 3
    assert len({r for r, _ in pairs}) == 3 and len({c for _, c in pairs}) == 3


# ==========================================================================
# Triage
# ==========================================================================

def _incident(**kw) -> Incident:
    base = dict(location=GeoPoint(23.8, 90.4), region_id="R", severity=3,
                affected_people=5, time_window_s=1800.0,
                requirements=[Requirement(ResourceType.AMBULANCE, 1)], reported_at=0.0)
    base.update(kw)
    return Incident(**base)


def test_priority_is_monotone_in_severity():
    prev = -1.0
    for sev in range(1, 6):
        s, _ = priority.score(_incident(severity=sev), now=0.0)
        assert s > prev, "severity must never reduce priority"
        prev = s


def test_priority_is_monotone_in_scale_and_vulnerability():
    a, _ = priority.score(_incident(affected_people=2), 0.0)
    b, _ = priority.score(_incident(affected_people=200), 0.0)
    assert b > a
    c, _ = priority.score(_incident(vulnerability=0.9), 0.0)
    d, _ = priority.score(_incident(vulnerability=0.0), 0.0)
    assert c > d


def test_aging_prevents_starvation_but_is_bounded():
    inc = _incident(severity=1, affected_people=1)
    early, _ = priority.score(inc, now=0.0)
    late, _ = priority.score(inc, now=7200.0)
    assert late > early, "a waiting incident must gain priority"
    cat, _ = priority.score(_incident(severity=5, affected_people=500), now=0.0)
    assert cat > late, "aging must not let a minor call outrank a catastrophe"


def test_breakdown_sums_to_total_and_is_versioned():
    inc = _incident(severity=4, affected_people=40, vulnerability=0.5,
                    hazard=HazardClass.FLOOD)
    total, b = priority.score(inc, 600.0)
    parts = sum(v for k, v in b.items()
                if not k.startswith("_") and isinstance(v, (int, float)))
    assert abs(parts - total) < 1e-6, "explanation must account for the whole score"
    assert b["_policy_version"] == priority.POLICY_VERSION


# ==========================================================================
# Conflict prevention
# ==========================================================================

def _resource(**kw) -> Resource:
    base = dict(resource_type=ResourceType.AMBULANCE, location=GeoPoint(23.8, 90.4),
                region_id="R", home_base=GeoPoint(23.8, 90.4))
    base.update(kw)
    return Resource(**base)


def test_second_reservation_is_denied():
    store = StateStore()
    r = _resource()
    store.put_resource(r)
    store.try_reserve(r.resource_id, "A", now=0.0)
    try:
        store.try_reserve(r.resource_id, "B", now=1.0)
        assert False, "double reservation must be refused"
    except ReservationDenied:
        pass


def test_expired_lease_is_reclaimed():
    store = StateStore(lease_ttl_s=10.0)
    r = _resource()
    store.put_resource(r)
    store.try_reserve(r.resource_id, "crashed-worker", now=0.0)
    assert store.reap_expired_leases(now=100.0) == 1
    assert store.resources[r.resource_id].state == ResourceState.AVAILABLE
    store.try_reserve(r.resource_id, "healthy-worker", now=101.0)   # must succeed


def test_stale_holder_cannot_release_someone_elses_lease():
    store = StateStore()
    r = _resource()
    store.put_resource(r)
    lease = store.try_reserve(r.resource_id, "A", now=0.0)
    assert store.release(r.resource_id, "LEASE-BOGUS", now=1.0) is False
    assert store.release(r.resource_id, lease.token, now=1.0) is True


def test_group_reservation_is_all_or_nothing():
    store = StateStore()
    a, b, c = _resource(), _resource(), _resource()
    for r in (a, b, c):
        store.put_resource(r)
    store.try_reserve(c.resource_id, "other", now=0.0)         # c is taken
    try:
        store.reserve_all([a.resource_id, b.resource_id, c.resource_id], "grp", now=1.0)
        assert False, "partial group reservation must not succeed"
    except ReservationDenied:
        pass
    assert store.resources[a.resource_id].state == ResourceState.AVAILABLE
    assert store.resources[b.resource_id].state == ResourceState.AVAILABLE


def test_cas_rejects_stale_version():
    store = StateStore()
    r = _resource()
    store.put_resource(r)
    stale = r.version
    r.version += 1                                              # somebody else wrote
    try:
        store.try_reserve(r.resource_id, "A", now=0.0, expected_version=stale)
        assert False, "stale CAS token must be rejected"
    except ConcurrencyError:
        pass


def test_no_double_booking_under_thread_contention():
    """
    The property that actually matters in production: many workers racing for
    the same scarce units must produce exactly one winner per unit.
    """
    store = StateStore()
    pool = [_resource() for _ in range(25)]
    for r in pool:
        store.put_resource(r)

    granted: list = []
    lock = threading.Lock()

    def worker(wid: int) -> None:
        rng = random.Random(wid)
        for _ in range(200):
            r = pool[rng.randrange(len(pool))]
            try:
                lease = store.try_reserve(r.resource_id, f"w{wid}", now=0.0)
            except (ReservationDenied, ConcurrencyError):
                continue
            with lock:
                granted.append((r.resource_id, lease.token))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    ids = [rid for rid, _ in granted]
    assert len(ids) == len(set(ids)), "a resource was leased twice"
    assert len(ids) == len(pool), "every resource should have exactly one holder"
    assert store.double_book_attempts > 0, "the test did not actually contend"


def test_integrity_check_detects_conflict():
    from aegis.domain.models import Assignment, AssignmentState
    store = StateStore()
    r = _resource()
    store.put_resource(r)
    for i in (1, 2):
        a = Assignment(incident_id=f"INC-{i}", resource_id=r.resource_id,
                       resource_type=ResourceType.AMBULANCE, eta_s=100, created_at=0,
                       cost=-1, state=AssignmentState.EN_ROUTE)
        store.assignments[a.assignment_id] = a
    assert any("DOUBLE-BOOK" in p for p in store.integrity_check())


# ==========================================================================
# Degradation and resilience
# ==========================================================================

def test_circuit_breaker_opens_then_half_opens():
    cb = CircuitBreaker(failure_threshold=3, reset_timeout_s=10.0)

    def boom():
        raise RuntimeError("down")

    for _ in range(3):
        try:
            cb.call(boom, now=0.0)
        except RuntimeError:
            pass
    assert cb.state == "open"
    try:
        cb.call(lambda: 1, now=1.0)
        assert False, "open circuit must fail fast"
    except CircuitOpen:
        pass
    assert cb.call(lambda: 42, now=20.0) == 42          # half-open probe succeeds


def test_eta_always_returns_a_number_when_router_is_down():
    eta = TravelTimeService()
    a, b = GeoPoint(23.8, 90.4), GeoPoint(23.9, 90.5)
    healthy = eta.estimate(a, b, ResourceType.AMBULANCE, 60.0, now=0.0)
    eta.router_healthy = False
    for t in range(1, 40):
        degraded = eta.estimate(a, b, ResourceType.AMBULANCE, 60.0, now=float(t) * 10)
        assert degraded > 0 and degraded == degraded, "dispatch must never block on routing"
    assert eta.degraded_calls > 0
    # Fallback must be conservative, never optimistic.
    eta2 = TravelTimeService()
    eta2.router_healthy = False
    assert eta2.estimate(a, b, ResourceType.AMBULANCE, 60.0, now=0.0) >= healthy


def test_road_closure_invalidates_only_the_affected_partition():
    eta = TravelTimeService(cache_ttl_s=600.0)
    a = GeoPoint(23.80, 90.40)
    near = GeoPoint(23.85, 90.45)
    far = GeoPoint(25.70, 89.20)
    eta.estimate(a, near, ResourceType.AMBULANCE, 60.0, now=0.0)
    eta.estimate(a, far, ResourceType.AMBULANCE, 60.0, now=0.0)
    hits_before = eta.cache.hits
    eta.apply_road_condition(RoadCondition(cell_of(near), 2.0, 900.0, "flood"))
    eta.estimate(a, far, ResourceType.AMBULANCE, 60.0, now=1.0)
    assert eta.cache.hits == hits_before + 1, "unrelated routes must stay cached"


def test_road_closure_increases_travel_time_and_expires():
    eta = TravelTimeService()
    a, b = GeoPoint(23.80, 90.40), GeoPoint(23.90, 90.50)
    clean = eta.estimate(a, b, ResourceType.AMBULANCE, 60.0, now=0.0)
    eta.apply_road_condition(RoadCondition(cell_of(b), 2.5, until=500.0, reason="flood"))
    assert eta.estimate(a, b, ResourceType.AMBULANCE, 60.0, now=1.0) > clean
    eta.expire_conditions(now=600.0)
    assert abs(eta.estimate(a, b, ResourceType.AMBULANCE, 60.0, now=601.0) - clean) < 1e-6


def test_helicopter_ignores_road_closures():
    eta = TravelTimeService()
    a, b = GeoPoint(23.80, 90.40), GeoPoint(24.60, 91.20)
    clean = eta.estimate(a, b, ResourceType.HELICOPTER, 210.0, now=0.0)
    eta.apply_road_condition(RoadCondition(cell_of(b), 3.0, until=9e9, reason="flood"))
    assert abs(eta.estimate(a, b, ResourceType.HELICOPTER, 210.0, now=1.0) - clean) < 1e-6


def test_event_bus_retries_then_dead_letters():
    bus = EventBus(max_attempts=3)
    seen = []

    def flaky(ev):
        seen.append(ev.event_id)
        raise ValueError("handler broken")

    bus.subscribe("t", flaky)
    bus.publish("t", "k", {}, 0.0)
    bus.drain()
    assert len(seen) == 3 and len(bus.dlq) == 1


def test_event_bus_preserves_per_key_order():
    bus = EventBus(partitions=8)
    got = []
    bus.subscribe("t", lambda ev: got.append(ev.payload["i"]))
    for i in range(50):
        bus.publish("t", "same-region", {"i": i}, float(i))
    bus.drain()
    assert got == list(range(50))


def test_cache_versioning_and_eviction():
    c = VersionedTTLCache(ttl_s=100.0, max_entries=3)
    for i in range(5):
        c.put(f"k{i}", i, "p", now=0.0)
    assert len(c._data) == 3 and c.evictions == 2
    c.put("x", 1, "p", now=0.0)
    assert c.get("x", "p", now=1.0) == 1
    c.bump_partition("p")
    assert c.get("x", "p", now=2.0) is None


def test_cache_single_flight():
    c = VersionedTTLCache()
    assert c.begin_compute("k") is True
    assert c.begin_compute("k") is False, "duplicate recomputation must be suppressed"
    c.end_compute("k")
    assert c.begin_compute("k") is True


# ==========================================================================
# Geo and coverage
# ==========================================================================

def test_spatial_index_finds_nearest_and_tracks_movement():
    idx = SpatialIndex()
    idx.upsert("a", GeoPoint(23.80, 90.40))
    idx.upsert("b", GeoPoint(25.70, 89.20))
    assert "a" in idx.near(GeoPoint(23.81, 90.41), want=1)
    idx.upsert("a", GeoPoint(25.71, 89.21))
    near = idx.near(GeoPoint(23.81, 90.41), want=1)
    assert set(near) <= {"a", "b"}
    idx.remove("a")
    assert len(idx) == 1


def test_coverage_penalty_rises_as_region_empties():
    f = DemandForecaster()
    for _ in range(5):
        f.observe("R", now=0.0)
    cm = CoverageModel(f, min_free_per_region=2, penalty_weight=8.0)
    r = _resource()
    plenty = cm.penalty(r, {("R", ResourceType.AMBULANCE): 9}, now=1.0)
    scarce = cm.penalty(r, {("R", ResourceType.AMBULANCE): 1}, now=1.0)
    assert plenty == 0.0 and scarce > 0.0


def test_forecaster_decays_and_excites():
    f = DemandForecaster()
    f.observe("R", now=0.0)
    hot = f.rate("R", now=1.0)
    cold = f.rate("R", now=20000.0)
    assert hot > cold >= 0.0


# ==========================================================================
# Engine end-to-end
# ==========================================================================

def _engine(coverage_weight: float = 1.0):
    m = Metrics()
    store = StateStore(metrics=m)
    eta = TravelTimeService(metrics=m)
    cov = CoverageModel(DemandForecaster())
    cfg = OptimizerConfig(coverage_weight=coverage_weight)
    return store, DispatchEngine(store, eta, cov, m, config=cfg), m


def test_engine_prefers_the_nearer_unit():
    store, eng, _ = _engine(coverage_weight=0.0)
    near = _resource(location=GeoPoint(23.81, 90.41))
    far = _resource(location=GeoPoint(24.40, 91.00))
    store.put_resource(near)
    store.put_resource(far)
    eng.reindex()
    inc = _incident()
    store.put_incident(inc)
    made = eng.assign_immediate(inc, now=0.0)
    assert len(made) == 1 and made[0].resource_id == near.resource_id


def test_engine_refuses_units_beyond_the_reach_radius():
    store, eng, _ = _engine(coverage_weight=0.0)
    unreachable = _resource(location=GeoPoint(30.0, 95.0))     # ~800 km away
    store.put_resource(unreachable)
    eng.reindex()
    inc = _incident()
    store.put_incident(inc)
    assert eng.assign_immediate(inc, now=0.0) == []
    assert inc.outstanding() == {ResourceType.AMBULANCE: 1}


def test_engine_never_double_books_across_two_incidents():
    store, eng, _ = _engine(coverage_weight=0.0)
    only = _resource(location=GeoPoint(23.81, 90.41))
    store.put_resource(only)
    eng.reindex()
    a, b = _incident(), _incident()
    store.put_incident(a)
    store.put_incident(b)
    eng.assign_immediate(a, now=0.0)
    eng.assign_immediate(b, now=1.0)
    assert store.integrity_check() == []
    assert len(store.live_assignments_for(b.incident_id)) == 0


def test_engine_writes_an_auditable_rationale():
    store, eng, _ = _engine(coverage_weight=0.0)
    store.put_resource(_resource(location=GeoPoint(23.81, 90.41)))
    eng.reindex()
    inc = _incident(severity=5, affected_people=120)
    store.put_incident(inc)
    made = eng.assign_immediate(inc, now=0.0)
    r = made[0].rationale
    for field in ("tier", "candidates_considered", "cost_breakdown", "priority_breakdown"):
        assert field in r, f"decision record missing {field}"
    for term in ("travel_term", "lateness_term", "coverage_term", "total"):
        assert term in r["cost_breakdown"]
    assert len(store.decision_log) == 1


def test_reoptimisation_upgrades_to_a_closer_unit_when_one_frees():
    store, eng, _ = _engine(coverage_weight=0.0)
    far = _resource(location=GeoPoint(24.05, 90.70), speed_kmph=60.0)
    store.put_resource(far)
    eng.reindex()
    inc = _incident(severity=5, time_window_s=5400.0)
    store.put_incident(inc)
    eng.assign_immediate(inc, now=0.0)
    assert store.live_assignments_for(inc.incident_id)[0].resource_id == far.resource_id

    near = _resource(location=GeoPoint(23.805, 90.405))
    store.put_resource(near)
    eng.reindex()
    eng.reoptimize(now=60.0)
    live = store.live_assignments_for(inc.incident_id)
    assert len(live) == 1, "the incident must not end up over-assigned"
    assert live[0].resource_id == near.resource_id, "a clearly better unit should take over"
    assert store.integrity_check() == []


def test_reoptimisation_leaves_a_settled_plan_alone():
    """Churn control: repeated epochs with no change must produce no churn."""
    store, eng, _ = _engine(coverage_weight=0.0)
    for _ in range(6):
        store.put_resource(_resource(location=GeoPoint(23.81, 90.41)))
    eng.reindex()
    inc = _incident(time_window_s=5400.0)
    store.put_incident(inc)
    eng.assign_immediate(inc, now=0.0)
    before = eng.reassignments
    for t in range(1, 15):
        eng.reoptimize(now=float(t) * 30.0)
    assert eng.reassignments == before, "a stable situation must not be re-planned"
    assert len(store.live_assignments_for(inc.incident_id)) == 1
    assert store.integrity_check() == []


def test_higher_priority_incident_wins_the_scarce_unit():
    store, eng, _ = _engine(coverage_weight=0.0)
    store.put_resource(_resource(location=GeoPoint(23.81, 90.41)))
    eng.reindex()
    minor = _incident(severity=1, affected_people=1, time_window_s=5400.0)
    major = _incident(severity=5, affected_people=400, vulnerability=0.9,
                      time_window_s=5400.0)
    store.put_incident(minor)
    store.put_incident(major)
    eng.reoptimize(now=0.0)
    assert len(store.live_assignments_for(major.incident_id)) == 1
    assert len(store.live_assignments_for(minor.incident_id)) == 0


def test_outbox_relays_exactly_once():
    store, eng, _ = _engine(coverage_weight=0.0)
    store.put_resource(_resource(location=GeoPoint(23.81, 90.41)))
    eng.reindex()
    inc = _incident()
    store.put_incident(inc)
    eng.assign_immediate(inc, now=0.0)
    published = []
    n1 = store.relay(lambda t, k, p, ts: published.append(p))
    n2 = store.relay(lambda t, k, p, ts: published.append(p))
    assert n1 == 1 and n2 == 0 and len(published) == 1


# ==========================================================================

def main() -> int:
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = []
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS  {name}")
        except Exception as exc:                                # noqa: BLE001
            failed.append((name, exc))
            print(f"  FAIL  {name}: {exc!r}")
    print(f"\n{len(tests) - len(failed)}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
