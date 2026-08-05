"""
Incident triage scoring.

Design stance: the scoring function is a **versioned, monotone, additive
model**, not a learned black box. Three reasons, all operational rather than
technical:

1. *Explainability is a hard requirement.* A dispatcher overruled by software
   must be able to see why. An additive model yields a per-term contribution
   breakdown for free; a gradient-boosted model does not.
2. *Monotonicity is a safety property.* Increasing severity, or affected
   people, or urgency must never lower priority. That is enforceable by
   construction here and only testable statistically in a learned model.
3. *Auditability after the fact.* Every score is stamped with the policy
   version, so a post-incident inquiry can replay the exact function that ran.

Learned components are still useful, but they belong upstream as *feature
estimators* (predicted casualty count, predicted escalation probability)
feeding this transparent aggregator - never as the aggregator itself.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict

from ..domain.models import HAZARD_RISK_SCORE, Incident

POLICY_VERSION = "triage-v1.3.0"


@dataclass(frozen=True)
class TriageWeights:
    severity: float = 0.32
    scale: float = 0.18          # number of people affected
    urgency: float = 0.24        # deadline pressure
    vulnerability: float = 0.10
    hazard: float = 0.10
    escalation: float = 0.06     # waiting-time aging
    #: Hard cap on the aging term. Without a cap, a large backlog of stale
    #: minor incidents would eventually outrank a fresh catastrophe.
    aging_cap: float = 12.0
    aging_halflife_s: float = 900.0

    def as_dict(self) -> Dict[str, float]:
        return {k: getattr(self, k) for k in
                ("severity", "scale", "urgency", "vulnerability", "hazard", "escalation")}


DEFAULT_WEIGHTS = TriageWeights()


def _severity_term(sev: int) -> float:
    """1..5 -> 0..1, convex so catastrophic separates sharply from serious."""
    return ((max(1, min(5, sev)) - 1) / 4.0) ** 0.85


def _scale_term(people: int) -> float:
    """Log-compressed: 500 casualties are not 100x worse than 5, but clearly
    worse. Saturates around 2000 to stop mass-casualty events from making all
    other terms irrelevant."""
    return min(1.0, math.log1p(max(0, people)) / math.log1p(2000))


def _urgency_term(incident: Incident, now: float) -> float:
    """
    Deadline pressure as consumed fraction of the survivability window.
    Past deadline the term saturates at 1.0 rather than growing without
    bound - an expired window should not let one incident monopolise the
    entire national fleet.
    """
    window = max(1.0, incident.time_window_s)
    elapsed = max(0.0, now - incident.reported_at)
    return min(1.0, elapsed / window) ** 0.7 * 0.5 + 0.5 * (1.0 / (1.0 + window / 1800.0))


def _escalation_term(incident: Incident, now: float, halflife: float) -> float:
    """Anti-starvation: unserved incidents gain priority over time. Bounded
    (see `aging_cap`) so it breaks ties without inverting triage."""
    waited = max(0.0, now - incident.reported_at)
    return 1.0 - math.exp(-waited / max(1.0, halflife))


def score(incident: Incident, now: float,
          w: TriageWeights = DEFAULT_WEIGHTS) -> tuple[float, Dict[str, float]]:
    """
    Returns (priority in 0..112, per-term contribution breakdown).

    The breakdown is attached to the incident and to every assignment
    rationale; it is what the operator console renders as "why".
    """
    terms = {
        "severity": _severity_term(incident.severity),
        "scale": _scale_term(incident.affected_people),
        "urgency": _urgency_term(incident, now),
        "vulnerability": max(0.0, min(1.0, incident.vulnerability)),
        "hazard": HAZARD_RISK_SCORE.get(incident.hazard, 0.0),
    }
    weights = w.as_dict()
    contributions = {k: 100.0 * weights[k] * v for k, v in terms.items()}

    aging = _escalation_term(incident, now, w.aging_halflife_s) * w.aging_cap
    contributions["escalation"] = aging

    total = sum(contributions.values())
    contributions["_total"] = total
    contributions["_policy_version"] = POLICY_VERSION  # type: ignore[assignment]
    return total, contributions


def rescore(incident: Incident, now: float, w: TriageWeights = DEFAULT_WEIGHTS) -> float:
    """Recompute in place. Called every optimizer epoch: priority is a
    function of time, so a static score computed at intake would be wrong
    within minutes."""
    total, breakdown = score(incident, now, w)
    incident.priority = total
    incident.priority_breakdown = breakdown
    return total


def explain(incident: Incident) -> str:
    """Human-readable one-liner for the dispatcher console and audit log."""
    b = incident.priority_breakdown
    if not b:
        return "not yet scored"
    parts = sorted(((k, v) for k, v in b.items()
                    if not k.startswith("_") and isinstance(v, (int, float))),
                   key=lambda kv: -kv[1])
    head = ", ".join(f"{k}={v:.1f}" for k, v in parts[:4])
    return f"priority {incident.priority:.1f} [{head}] ({b.get('_policy_version')})"
