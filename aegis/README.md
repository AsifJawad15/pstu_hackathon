# AEGIS — Adaptive Emergency Grid for Incident Steering

Reference implementation of an intelligent emergency response and resource
optimization platform: a backend that ingests a continuous stream of emergency
incidents, triages them explainably, allocates ambulances / rescue teams / fire
units / helicopters / hospital capacity through an exact constrained-assignment
solver, and continuously re-optimises as roads close, vehicles fail, hospitals
saturate and new emergencies arrive.

This is not a mock-up. The simulation harness drives the real decision core, so
every number in the accompanying report was produced by running this code.

---

## Quickstart

No third-party packages are required. Python 3.9+.

```bash
python tests/test_all.py                    # 36 tests, ~20 s
python run_simulation.py                    # full ablation, 12 simulated hours
python run_simulation.py --hours 4          # faster run
python run_simulation.py --policy aegis     # single policy + sample decision records
python run_simulation.py --seeds 3          # repeat across seeds, report medians
python make_tables.py                       # regenerate the report's tables
```

Outputs land in `artifacts/`: `results.json` (full metrics, per-run and
aggregated) and `results.md` (human-readable comparison).

`scipy` is used for the assignment solver if present, purely for speed; a pure
Python Jonker–Volgenant implementation is the fallback and the test suite
asserts both agree.

---

## Results

12 simulated hours, 342 incidents, 230 assets across 8 regions, 50 injected
environment disruptions including a 3.8-hour cyclone surge and a mid-surge
routing-engine outage. Median of 3 seeds. Every policy replays a
byte-identical event stream.

| Metric | Baseline | + Triage | + Re-opt | **AEGIS** | Change |
|---|---:|---:|---:|---:|---:|
| Mean first-response (min) | 45.72 | 42.55 | 36.17 | **39.47** | −13.7% |
| Median first-response (min) | 25.88 | 25.28 | 26.69 | **30.94** | +19.6% |
| p90 first-response (min) | 128.49 | 100.06 | 72.96 | **78.41** | −39.0% |
| p99 first-response (min) | 208.19 | 205.01 | 146.69 | **155.81** | −25.2% |
| Severity-weighted response (min) | 179.33 | 168.83 | 132.44 | **146.11** | −18.5% |
| Reached within clinical window (%) | 61.07 | 60.81 | 67.43 | **66.38** | +8.7% |
| Never reached (%) | 17.24 | 18.97 | 18.07 | **14.08** | −18.3% |
| Fleet utilisation (%) | 28.97 | 28.70 | 34.61 | **39.65** | +36.9% |
| Assignment churn (% of commits) | 0.00 | 0.00 | 2.96 | **6.10** | — |

Invariants held in every configuration and every seed:

- **0 resource conflicts** (integrity audit over final state, plus a
  multi-threaded contention test racing 12 workers over 25 units)
- Tier-1 admission **p99 = 2.4 ms** (budget 200 ms)
- Tier-2 shard epoch **p99 = 38.5 ms** (budget 400 ms)
- Travel-time cache hit rate **97–98%**
- **2,236 degraded travel-time estimates** served through the fallback during
  the injected routing outage, with **0 failed dispatches**
- 0 events dead-lettered

Honest caveats. The **median rises** (25.9 → 30.9 min) while every tail
percentile falls sharply — redistribution, not regression: triage deliberately
makes routine calls wait so contended ones are reached at all. And the full
configuration is *worse* than the re-optimisation-only one on mean response
(39.5 vs 36.2 min), buying a large reduction in incidents never reached at all
(14.1% vs 18.1%). Coverage weight is a policy dial, not a free win. Both are
discussed in the report rather than hidden.

Evaluation is deterministic: the solver epoch is bounded by a work budget
rather than wall-clock time during evaluation runs, so replaying the same
stream twice gives identical numbers.

---

## Layout

```
src/aegis/
  domain/models.py      entities, state machines, assignment maturity, journey projection
  core/geo.py           haversine, cell index, bucketed spatial index (expanding-ring search)
  core/eta.py           travel time: versioned cache, circuit breaker, pessimistic fallback
  core/priority.py      explainable additive triage model, bounded anti-starvation aging
  core/matching.py      Jonker–Volgenant exact assignment, greedy warm start, LNS
  core/coverage.py      self-exciting demand forecast, reserve protection, idle relocation
  core/optimizer.py     two-tier engine, geographic sharding, churn control, decision records
  infra/store.py        leases, optimistic concurrency, group-reservation saga, outbox, audit
  infra/event_bus.py    partitioned log: ordering, bounded retry, DLQ, consumer lag
  infra/cache.py        versioned TTL cache, XFetch early expiry, single-flight
  infra/circuit_breaker.py
  infra/metrics.py      counters, gauges, quantile histograms
  sim/scenario.py       deterministic scenario generator
  sim/simulator.py      discrete-event harness with policy ablation
tests/test_all.py       36 tests
run_simulation.py       evaluation entrypoint
make_tables.py          renders results.json into the report's LaTeX tables
docs/                   full architecture report (LaTeX source + PDF)
```

---

## The core idea, in one paragraph

The dispatch problem is a generalized assignment problem with side constraints
— NP-hard. **Requirement expansion** turns it tractable: an incident needing 2
ambulances and 1 rescue team becomes three independent unit-slots, after which
the core problem is a *rectangular linear assignment problem* solvable exactly
in O(n³). Scarcity, hospital capacity, coverage reserve and plan stability are
expressed as terms in the cost matrix rather than as heuristics bolted on
afterwards, and an anytime Large Neighbourhood Search handles the residue. One
cost function therefore governs the sub-millisecond fast path, the exact
optimal path, and the explanation shown to the human dispatcher.

## Four bugs worth knowing about

Each of these individually made the "optimised" system perform **worse** than
the naive baseline, while every architecture diagram still looked correct.
They are documented in the code because they are the non-obvious part:

1. **No feasibility cutoff on an exact matcher.** A minimum-cost assignment
   assigns *every row it is given*. Without a hard reach radius it dispatched
   ambulances from hundreds of kilometres away, removing them from the pool
   for hours to arrive long after the clinical window closed.
2. **Coverage penalty charged against already-dispatched units.** Coverage
   measures the cost of taking a unit *out of the idle pool*; charging a unit
   that had already left made every busy vehicle look expensive relative to an
   idle one, so the solver swapped them continuously.
3. **Slot-index instead of demand-level comparison.** Two slots of the same
   type on the same incident are interchangeable; comparing indices reported a
   unit as displaced whenever the solver merely permuted columns.
4. **Stale positions for units in motion.** Re-costing a moving vehicle from
   the depot it left twenty minutes ago makes it look permanently far away.

Before these fixes the engine issued 2,233 assignments for 148 incidents.
Afterwards, churn is under 6% of commits.

---

## License / provenance

Written as a preliminary-round submission. All evaluation figures are
reproducible from this repository with the commands above.
