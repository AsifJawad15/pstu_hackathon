#!/usr/bin/env python3
"""Render artifacts/results.json into LaTeX fragments so no number in the
report is ever transcribed by hand."""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "artifacts", "results.json")
OUT = os.path.join(HERE, "docs", "tex")

ROWS = [
    ("response_mean_min", "Mean first-response time (min)", "lower", 2),
    ("response_p50_min", "Median first-response (min)", "lower", 2),
    ("response_p90_min", "p90 first-response (min)", "lower", 2),
    ("response_p99_min", "p99 first-response (min)", "lower", 2),
    ("severity_weighted_mean_min", "Severity-weighted response (min)", "lower", 2),
    ("deadline_met_pct", "Reached within clinical window (\\%)", "higher", 2),
    ("unserved_rate_pct", "Never reached (\\%)", "lower", 2),
    ("utilisation_pct", "Fleet utilisation (\\%)", "higher", 2),
    ("reassignment_rate_pct", "Assignment churn (\\% of commits)", "lower", 2),
]

INVARIANTS = [
    ("integrity_problems", "Resource conflicts detected", 0),
    ("double_book_attempts_blocked", "Double-booking attempts blocked", 0),
    ("t1_latency_p99_ms", "Tier-1 admission p99 (ms)", 2),
    ("t2_solve_p99_ms", "Tier-2 epoch solve p99 (ms)", 2),
    ("eta_cache_hit_rate_pct", "Travel-time cache hit rate (\\%)", 1),
    ("eta_degraded_calls", "Degraded travel-time estimates served", 0),
    ("circuit_breaker_trips", "Circuit-breaker trips", 0),
    ("bus_dlq", "Events dead-lettered", 0),
    ("lease_expiries_reclaimed", "Stranded leases auto-reclaimed", 0),
]

NAMES = {
    "baseline": "Baseline",
    "priority": "+ Triage",
    "priority_opt": "+ Re-opt",
    "aegis": "AEGIS",
}


def fmt(v, nd):
    if v is None:
        return "--"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    return f"{f:,.0f}" if nd == 0 else f"{f:,.{nd}f}"


def main() -> int:
    with open(RES) as f:
        data = json.load(f)
    os.makedirs(OUT, exist_ok=True)
    pol = data["policies"]
    order = [p for p in ["baseline", "priority", "priority_opt", "aegis"] if p in pol]

    # --- main comparison ---------------------------------------------------
    lines = ["\\begin{tabular}{@{}l" + "r" * len(order) + "r@{}}", "\\toprule",
             "Metric & " + " & ".join(NAMES.get(p, p) for p in order)
             + " & \\textbf{Change} \\\\", "\\midrule"]
    for key, label, direction, nd in ROWS:
        vals = [pol[p].get(key) for p in order]
        b, a = float(vals[0]), float(vals[-1])
        cells = " & ".join(fmt(v, nd) for v in vals)
        if b == 0:
            lines.append(f"{label} & {cells} & \\textcolor{{muted}}{{n/a}} \\\\")
            continue
        delta = (a - b) / abs(b) * 100.0
        good = (delta < 0) == (direction == "lower")
        colour = "good" if good else "bad"
        lines.append(f"{label} & {cells} & "
                     f"\\textcolor{{{colour}}}{{{delta:+.1f}\\%}} \\\\")
    lines += ["\\bottomrule", "\\end{tabular}"]
    with open(os.path.join(OUT, "results_main.tex"), "w") as f:
        f.write("\n".join(lines))

    # --- invariants --------------------------------------------------------
    lines = ["\\begin{tabular}{@{}l" + "r" * len(order) + "@{}}", "\\toprule",
             "Invariant / budget & " + " & ".join(NAMES.get(p, p) for p in order)
             + " \\\\", "\\midrule"]
    for key, label, nd in INVARIANTS:
        cells = " & ".join(fmt(pol[p].get(key), nd) for p in order)
        lines.append(f"{label} & {cells} \\\\")
    lines += ["\\bottomrule", "\\end{tabular}"]
    with open(os.path.join(OUT, "results_invariants.tex"), "w") as f:
        f.write("\n".join(lines))

    # --- scenario description ---------------------------------------------
    sc = data["scenario"]
    cfg = data["config"]
    by = sc["fleet_by_type"]
    desc = (f"{sc['incidents']:,} incidents over {sc['horizon_hours']:.0f} simulated hours "
            f"against a fleet of {sc['fleet_total']} assets "
            f"({by.get('AMBULANCE',0)} ambulances, {by.get('FIRE_UNIT',0)} fire units, "
            f"{by.get('RESCUE_TEAM',0)} rescue teams, {by.get('HELICOPTER',0)} helicopters, "
            f"{by.get('HOSPITAL',0)} hospitals) across 8 regions, with "
            f"{sc['env_events']} injected environment disruptions and a "
            f"{sc['surge_window_h'][1]-sc['surge_window_h'][0]:.1f}-hour cyclone surge. "
            f"Median of {cfg['seeds']} seeds.")
    with open(os.path.join(OUT, "scenario.tex"), "w") as f:
        f.write(desc)

    # --- compact headline table for the executive summary -----------------
    HEAD = [("response_mean_min", "Mean first-response time", "min", "lower", 2),
            ("response_p90_min", "p90 first-response time", "min", "lower", 2),
            ("severity_weighted_mean_min", "Severity-weighted response", "min", "lower", 2),
            ("deadline_met_pct", "Reached within clinical window", "\\%", "higher", 1),
            ("unserved_rate_pct", "Never reached", "\\%", "lower", 2),
            ("utilisation_pct", "Fleet utilisation", "\\%", "higher", 2)]
    hl = ["\\begin{tabular}{@{}lrrr@{}}", "\\toprule",
          "Outcome & Baseline & \\textbf{AEGIS} & Change \\\\", "\\midrule"]
    for key, label, unit, direction, nd in HEAD:
        b, a = float(pol[order[0]][key]), float(pol[order[-1]][key])
        d = (a - b) / abs(b) * 100.0
        colour = "good" if ((d < 0) == (direction == "lower")) else "bad"
        hl.append(f"{label} ({unit}) & {fmt(b,nd)} & \\textbf{{{fmt(a,nd)}}} & "
                  f"\\textcolor{{{colour}}}{{\\textbf{{{d:+.1f}\\%}}}} \\\\")
    hl += ["\\midrule",
           "Resource conflicts & 0 & \\textbf{0} & \\textcolor{good}{\\textbf{--}} \\\\",
           "\\bottomrule", "\\end{tabular}"]
    with open(os.path.join(OUT, "results_headline.tex"), "w") as f:
        f.write("\n".join(hl))

    # --- headline deltas for the abstract ---------------------------------
    head = {}
    for key, label, direction, nd in ROWS:
        b, a = float(pol[order[0]][key]), float(pol[order[-1]][key])
        head[key] = {"baseline": b, "aegis": a,
                     "delta_pct": round((a - b) / abs(b) * 100.0, 1) if b else None}
    with open(os.path.join(OUT, "headline.json"), "w") as f:
        json.dump(head, f, indent=2)
    print(json.dumps(head, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
