#!/usr/bin/env python3
"""
AEGIS reference-implementation evaluation harness.

    python run_simulation.py                  # full ablation, 12 simulated hours
    python run_simulation.py --hours 6        # shorter run
    python run_simulation.py --policy aegis   # single policy
    python run_simulation.py --seeds 3        # repeat across seeds for variance

Writes artifacts/results.json, artifacts/results.md and a sample of the
decision journal so that any single dispatch decision can be inspected.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from typing import Dict, List

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))

from aegis.sim.scenario import build_scenario                     # noqa: E402
from aegis.sim.simulator import POLICIES, RunResult, Simulator    # noqa: E402

ORDER = ["baseline", "priority", "priority_opt", "aegis"]

HEADLINE = [
    ("response_mean_min", "Mean first-response (min)", "lower"),
    ("response_p90_min", "p90 first-response (min)", "lower"),
    ("severity_weighted_mean_min", "Severity-weighted response (min)", "lower"),
    ("deadline_met_pct", "Incidents reached within window (%)", "higher"),
    ("unserved_rate_pct", "Never reached (%)", "lower"),
    ("utilisation_pct", "Fleet utilisation (%)", "higher"),
    ("response_p99_min", "p99 first-response (min)", "lower"),
    ("reassignment_rate_pct", "Assignment churn (% of commits)", "lower"),
]


def run_one(policy_name: str, hours: float, seed: int, verbose: bool = False) -> RunResult:
    scenario = build_scenario(seed=seed, hours=hours)
    sim = Simulator(scenario, POLICIES[policy_name], seed=seed + 17, verbose=verbose)
    t0 = time.perf_counter()
    result = sim.run()
    result.metrics["wallclock_s"] = round(time.perf_counter() - t0, 2)
    result.metrics["scenario"] = scenario.summary()
    if verbose:
        journal = sim.store.decision_log
        result.metrics["_sample_decisions"] = journal[:3]
    return result


def pct_change(base: float, new: float, direction: str) -> float:
    if base in (0, None) or base != base:
        return float("nan")
    delta = (new - base) / abs(base) * 100.0
    return delta


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=12.0)
    ap.add_argument("--seed", type=int, default=20260806)
    ap.add_argument("--seeds", type=int, default=1, help="repeat with N consecutive seeds")
    ap.add_argument("--policy", type=str, default=None)
    ap.add_argument("--out", type=str, default="artifacts")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    policies = [args.policy] if args.policy else ORDER

    all_runs: Dict[str, List[RunResult]] = {p: [] for p in policies}
    for k in range(args.seeds):
        seed = args.seed + k * 1009
        for p in policies:
            print(f"[run] policy={p:<13} seed={seed} hours={args.hours}", flush=True)
            r = run_one(p, args.hours, seed, verbose=(k == 0 and p == "aegis"))
            all_runs[p].append(r)
            print(f"       mean={r.get('response_mean_min')} min  "
                  f"p90={r.get('response_p90_min')} min  "
                  f"in-window={r.get('deadline_met_pct')}%  "
                  f"util={r.get('utilisation_pct')}%  "
                  f"conflicts={len(r.integrity_problems)}", flush=True)

    # Aggregate across seeds (median, which is robust for small N).
    agg: Dict[str, Dict[str, object]] = {}
    for p, runs in all_runs.items():
        keys = [k for k in runs[0].metrics
                if isinstance(runs[0].metrics[k], (int, float))]
        agg[p] = {k: round(statistics.median([float(r.metrics[k]) for r in runs]), 3)
                  for k in keys}
        agg[p]["label"] = runs[0].label
        agg[p]["integrity_problems"] = sum(len(r.integrity_problems) for r in runs)
        agg[p]["decision_records"] = runs[0].decision_records

    payload = {
        "config": {"hours": args.hours, "seed": args.seed, "seeds": args.seeds},
        "scenario": all_runs[policies[0]][0].metrics.get("scenario"),
        "policies": agg,
        "per_run": {p: [r.metrics for r in runs] for p, runs in all_runs.items()},
    }
    with open(os.path.join(args.out, "results.json"), "w") as f:
        json.dump(payload, f, indent=2, default=str)

    lines: List[str] = ["# AEGIS evaluation results", ""]
    sc = payload["scenario"]
    lines.append(f"Scenario: {sc['incidents']} incidents over {sc['horizon_hours']} h, "
                 f"fleet of {sc['fleet_total']} assets, {sc['env_events']} environment "
                 f"disruptions, surge window {sc['surge_window_h']} h.")
    lines.append("")
    header = "| Metric | " + " | ".join(policies) + " |"
    lines += [header, "|" + "---|" * (len(policies) + 1)]
    for key, label, direction in HEADLINE:
        row = [label]
        for p in policies:
            row.append(f"{agg[p].get(key, float('nan')):.2f}")
        lines.append("| " + " | ".join(row) + " |")

    if "baseline" in policies and "aegis" in policies:
        lines += ["", "## AEGIS vs baseline", ""]
        for key, label, direction in HEADLINE:
            b, a = float(agg["baseline"][key]), float(agg["aegis"][key])
            d = pct_change(b, a, direction)
            arrow = "improved" if ((d < 0) == (direction == "lower")) else "worse"
            lines.append(f"- **{label}**: {b:.2f} -> {a:.2f} ({d:+.1f}%, {arrow})")

    lines += ["", "## Safety and performance invariants", ""]
    for p in policies:
        lines.append(f"- `{p}`: resource conflicts={agg[p]['integrity_problems']}, "
                     f"double-book attempts blocked={agg[p].get('double_book_attempts_blocked')}, "
                     f"T1 p99={agg[p].get('t1_latency_p99_ms')} ms, "
                     f"T2 solve p99={agg[p].get('t2_solve_p99_ms')} ms, "
                     f"ETA cache hit={agg[p].get('eta_cache_hit_rate_pct')}%, "
                     f"degraded ETA calls={agg[p].get('eta_degraded_calls')}, "
                     f"DLQ={agg[p].get('bus_dlq')}")

    with open(os.path.join(args.out, "results.md"), "w") as f:
        f.write("\n".join(lines) + "\n")

    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
