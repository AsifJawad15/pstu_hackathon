"""Exact, deadline-bounded resource-bundle solver.

The regional API remains authoritative for hard feasibility. This module only
chooses the lowest-cost subset that covers the required capabilities and
aggregate capacity. A deterministic greedy incumbent is created first, then a
bounded dynamic program proves or improves it. The state ceiling and deadline
make memory and latency explicit rather than input-dependent surprises.
"""
from __future__ import annotations

from dataclasses import dataclass
from time import perf_counter
from typing import Any, Dict, Iterable, List, Mapping, Sequence, Tuple


MAX_CANDIDATES = 64
MAX_CAPABILITIES = 16
MAX_REQUIRED_CAPACITY = 10_000
MAX_STATES = 50_000


class InvalidOptimizationRequest(ValueError):
    """The request cannot be solved safely."""


@dataclass(frozen=True)
class Candidate:
    resource_id: str
    cost: int
    capacity: int
    capability_mask: int


@dataclass(frozen=True)
class Plan:
    resource_ids: Tuple[str, ...]
    objective: int
    capacity: int
    capability_mask: int


def solve_bundle(payload: Mapping[str, Any]) -> Dict[str, Any]:
    started = perf_counter()
    deadline_ms = _bounded_int(payload.get("deadlineMs", 40), "deadlineMs", 1, 500)
    required_capacity = _bounded_int(
        payload.get("requiredCapacity", 1), "requiredCapacity", 1, MAX_REQUIRED_CAPACITY
    )
    required_capabilities = _string_list(
        payload.get("requiredCapabilities"), "requiredCapabilities", MAX_CAPABILITIES
    )
    if not required_capabilities:
        raise InvalidOptimizationRequest("requiredCapabilities must not be empty")
    required_capabilities = sorted(set(required_capabilities))
    capability_index = {name: index for index, name in enumerate(required_capabilities)}
    full_mask = (1 << len(required_capabilities)) - 1
    candidates = _parse_candidates(payload.get("candidates"), capability_index)
    max_states = _bounded_int(payload.get("maxStates", MAX_STATES), "maxStates", 100, MAX_STATES)
    deadline_at = started + deadline_ms / 1_000.0

    incumbent = _greedy(candidates, required_capacity, full_mask)
    if incumbent is None:
        return _response("NO_FEASIBLE_BUNDLE", None, False, 0, started, deadline_ms)

    # (covered capability mask, capped capacity) -> (objective, sorted IDs)
    states: Dict[Tuple[int, int], Tuple[int, Tuple[str, ...]]] = {(0, 0): (0, ())}
    examined = 0
    truncated = False
    for candidate in candidates:
        additions: Dict[Tuple[int, int], Tuple[int, Tuple[str, ...]]] = {}
        for (mask, capacity), (cost, ids) in tuple(states.items()):
            examined += 1
            if examined % 128 == 0 and perf_counter() >= deadline_at:
                truncated = True
                break
            new_mask = mask | candidate.capability_mask
            new_capacity = min(required_capacity, capacity + candidate.capacity)
            if new_mask == mask and new_capacity == capacity:
                continue
            new_cost = cost + candidate.cost
            # Costs are non-negative, so a state already above the incumbent
            # objective cannot improve the final plan.
            if new_cost > incumbent.objective:
                continue
            new_ids = tuple(sorted((*ids, candidate.resource_id)))
            key = (new_mask, new_capacity)
            existing = additions.get(key) or states.get(key)
            if existing is None or (new_cost, new_ids) < existing:
                additions[key] = (new_cost, new_ids)
        if truncated:
            break
        for key, value in additions.items():
            existing = states.get(key)
            if existing is None or value < existing:
                states[key] = value
        if len(states) > max_states:
            truncated = True
            break

    exact = states.get((full_mask, required_capacity))
    if exact is not None and (exact[0], exact[1]) < (incumbent.objective, incumbent.resource_ids):
        selected = {candidate.resource_id: candidate for candidate in candidates}
        incumbent = Plan(
            resource_ids=exact[1], objective=exact[0],
            capacity=sum(selected[item].capacity for item in exact[1]),
            capability_mask=full_mask,
        )
    algorithm = "GREEDY_INCUMBENT" if truncated else "EXACT_BOUNDED_DP"
    return _response(algorithm, incumbent, not truncated, examined, started, deadline_ms)


def _greedy(candidates: Sequence[Candidate], required_capacity: int, full_mask: int) -> Plan | None:
    remaining = list(candidates)
    selected: List[Candidate] = []
    mask = 0
    capacity = 0
    while mask != full_mask or capacity < required_capacity:
        best: Candidate | None = None
        best_rank: Tuple[float, int, str] | None = None
        for candidate in remaining:
            new_capability_count = (candidate.capability_mask & ~mask).bit_count()
            capacity_gain = min(required_capacity - min(capacity, required_capacity), candidate.capacity)
            contribution = new_capability_count * (required_capacity + 1) + capacity_gain
            if contribution <= 0:
                continue
            rank = (candidate.cost / contribution, candidate.cost, candidate.resource_id)
            if best_rank is None or rank < best_rank:
                best, best_rank = candidate, rank
        if best is None:
            return None
        selected.append(best)
        remaining.remove(best)
        mask |= best.capability_mask
        capacity += best.capacity
    return Plan(
        resource_ids=tuple(sorted(item.resource_id for item in selected)),
        objective=sum(item.cost for item in selected), capacity=capacity,
        capability_mask=mask,
    )


def _parse_candidates(value: Any, capability_index: Mapping[str, int]) -> List[Candidate]:
    if not isinstance(value, list) or not value or len(value) > MAX_CANDIDATES:
        raise InvalidOptimizationRequest(f"candidates must contain 1 to {MAX_CANDIDATES} entries")
    parsed: List[Candidate] = []
    seen = set()
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise InvalidOptimizationRequest(f"candidates[{index}] must be an object")
        resource_id = item.get("resourceId")
        if not isinstance(resource_id, str) or not resource_id or len(resource_id) > 128:
            raise InvalidOptimizationRequest(f"candidates[{index}].resourceId is invalid")
        if resource_id in seen:
            raise InvalidOptimizationRequest("candidate resource IDs must be unique")
        seen.add(resource_id)
        cost = _bounded_int(item.get("cost"), f"candidates[{index}].cost", 0, 100_000_000)
        capacity = _bounded_int(item.get("capacity"), f"candidates[{index}].capacity", 0, MAX_REQUIRED_CAPACITY)
        capabilities = _string_list(item.get("capabilities"), f"candidates[{index}].capabilities", 64)
        mask = 0
        for capability in capabilities:
            bit = capability_index.get(capability)
            if bit is not None:
                mask |= 1 << bit
        parsed.append(Candidate(resource_id, cost, capacity, mask))
    return sorted(parsed, key=lambda candidate: candidate.resource_id)


def _string_list(value: Any, field: str, maximum: int) -> List[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise InvalidOptimizationRequest(f"{field} must be a list with at most {maximum} entries")
    output: List[str] = []
    for item in value:
        if not isinstance(item, str) or not item or len(item) > 64:
            raise InvalidOptimizationRequest(f"{field} contains an invalid value")
        output.append(item)
    return output


def _bounded_int(value: Any, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise InvalidOptimizationRequest(f"{field} must be an integer from {minimum} to {maximum}")
    return value


def _response(
    algorithm: str, plan: Plan | None, optimal: bool, examined: int,
    started: float, deadline_ms: int,
) -> Dict[str, Any]:
    duration_ms = round((perf_counter() - started) * 1_000.0, 3)
    return {
        "schemaVersion": 1,
        "solverVersion": "aegis-bundle-1",
        "algorithm": algorithm,
        "optimal": optimal,
        "feasible": plan is not None,
        "selectedResourceIds": list(plan.resource_ids) if plan else [],
        "objective": plan.objective if plan else None,
        "coveredCapacity": plan.capacity if plan else 0,
        "examinedStates": examined,
        "durationMs": duration_ms,
        "deadlineMs": deadline_ms,
    }
