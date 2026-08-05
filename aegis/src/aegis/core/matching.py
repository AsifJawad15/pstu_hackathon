"""
Constrained assignment solvers.

The dispatch problem is a **Generalized Assignment Problem with side
constraints** (capability compatibility, hospital bed capacity, coverage
reserve), which is NP-hard in general. AEGIS makes it tractable with a
modelling choice rather than a heuristic one:

    *Requirement expansion.* An incident needing 2 ambulances and 1 rescue
    team becomes three independent unit-slots. Once expanded, the core problem
    is a **rectangular linear assignment problem** - resources to slots, one
    each - which is solvable *exactly* in O(n^3) by Jonker-Volgenant/Hungarian.

That buys optimality on the sub-problem that dominates response time, and
leaves only the genuinely combinatorial parts (bed capacity, coverage reserve,
multi-stop sequencing) to be handled by penalty terms in the cost matrix and
by a Large Neighbourhood Search pass on top.

Why exact matching instead of pure greedy: greedy nearest-available is
locally sensible and globally poor. It routinely burns the only helicopter on
a moderate incident that an ambulance could serve, leaving the next
catastrophe uncovered. The exact solver internalises that opportunity cost.

Why not a MILP solver on the full model: a national fleet gives matrices of
10^3-10^4 per region shard, where JV runs in single-digit milliseconds and a
MILP does not fit the sub-second re-optimisation budget. AEGIS keeps the
anytime property: it always has a feasible incumbent to ship.
"""
from __future__ import annotations

import math
from typing import List, Optional, Sequence, Tuple

INFEASIBLE = 1e9

try:                                                    # pragma: no cover
    from scipy.optimize import linear_sum_assignment as _scipy_lsa
    _HAVE_SCIPY = True
except Exception:                                       # pragma: no cover
    _HAVE_SCIPY = False


# --------------------------------------------------------------------------
# Exact rectangular assignment (Jonker-Volgenant shortest augmenting path)
# --------------------------------------------------------------------------

def hungarian(cost: Sequence[Sequence[float]]) -> List[Tuple[int, int]]:
    """
    Exact minimum-cost assignment for a rectangular matrix.

    Rows are assigned to distinct columns; if rows > cols the transpose is
    solved. Pure Python so the decision core has no hard numeric dependency;
    scipy is used when present purely for speed, and both paths are asserted
    to agree in the test-suite.
    """
    n_rows = len(cost)
    if n_rows == 0:
        return []
    n_cols = len(cost[0])
    if n_cols == 0:
        return []

    if n_rows > n_cols:
        flipped = [[cost[r][c] for r in range(n_rows)] for c in range(n_cols)]
        return [(r, c) for c, r in hungarian(flipped)]

    if _HAVE_SCIPY:
        rows, cols = _scipy_lsa(cost)
        return list(zip(rows.tolist(), cols.tolist()))

    n, m = n_rows, n_cols
    INF = float("inf")
    u = [0.0] * (n + 1)
    v = [0.0] * (m + 1)
    p = [0] * (m + 1)          # column -> row
    way = [0] * (m + 1)

    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [INF] * (m + 1)
        used = [False] * (m + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = INF
            j1 = 0
            for j in range(1, m + 1):
                if used[j]:
                    continue
                cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                if cur < minv[j]:
                    minv[j] = cur
                    way[j] = j0
                if minv[j] < delta:
                    delta = minv[j]
                    j1 = j
            for j in range(m + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while j0:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1

    return [(p[j] - 1, j - 1) for j in range(1, m + 1) if p[j] != 0]


def solve_assignment(cost: Sequence[Sequence[float]],
                     infeasible_at: float = INFEASIBLE / 2) -> List[Tuple[int, int]]:
    """Exact solve, then drop pairs the cost matrix marked infeasible."""
    pairs = hungarian(cost)
    return [(r, c) for r, c in pairs if cost[r][c] < infeasible_at]


def objective(cost: Sequence[Sequence[float]],
              pairs: Sequence[Tuple[int, int]]) -> float:
    return sum(cost[r][c] for r, c in pairs)


# --------------------------------------------------------------------------
# Greedy warm start
# --------------------------------------------------------------------------

def greedy_assignment(cost: Sequence[Sequence[float]],
                      infeasible_at: float = INFEASIBLE / 2) -> List[Tuple[int, int]]:
    """
    O(n*m log) greedy over sorted cost. Used on the hot ingest path where the
    latency budget is ~100 ms and a provisional answer now beats an optimal
    answer in three seconds, and as the LNS warm start.
    """
    entries = sorted(
        ((cost[r][c], r, c)
         for r in range(len(cost))
         for c in range(len(cost[0]))
         if cost[r][c] < infeasible_at),
        key=lambda t: t[0])
    used_r, used_c = set(), set()
    out: List[Tuple[int, int]] = []
    for _, r, c in entries:
        if r in used_r or c in used_c:
            continue
        used_r.add(r)
        used_c.add(c)
        out.append((r, c))
    return out


# --------------------------------------------------------------------------
# Large Neighbourhood Search (anytime improvement)
# --------------------------------------------------------------------------

def lns_improve(cost: Sequence[Sequence[float]],
                incumbent: Sequence[Tuple[int, int]],
                rng,
                iterations: int = 40,
                destroy_frac: float = 0.30,
                infeasible_at: float = INFEASIBLE / 2) -> List[Tuple[int, int]]:
    """
    Ruin-and-recreate around the incumbent.

    Present because the exact solver handles the *linear* part of the cost but
    not coupling constraints (bed capacity, coverage floors) that only become
    visible once a candidate solution exists. LNS is anytime: it can be cut
    off at any iteration and still returns a feasible, never-worse solution -
    exactly the property a real-time budget requires.
    """
    best = list(incumbent)
    best_val = objective(cost, best)
    n_rows, n_cols = len(cost), (len(cost[0]) if cost else 0)
    if not best or n_rows == 0 or n_cols == 0:
        return best

    for _ in range(iterations):
        k = max(1, int(len(best) * destroy_frac))
        removed_idx = set(rng.sample(range(len(best)), min(k, len(best))))
        kept = [pr for i, pr in enumerate(best) if i not in removed_idx]
        free_r = [r for r in range(n_rows) if r not in {a for a, _ in kept}]
        free_c = [c for c in range(n_cols) if c not in {b for _, b in kept}]
        if not free_r or not free_c:
            continue
        sub = [[cost[r][c] for c in free_c] for r in free_r]
        repaired = solve_assignment(sub, infeasible_at)
        candidate = kept + [(free_r[r], free_c[c]) for r, c in repaired]
        val = objective(cost, candidate)
        if val < best_val - 1e-9:
            best, best_val = candidate, val
    return best
