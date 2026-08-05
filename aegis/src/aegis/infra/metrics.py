"""
Metrics registry.

Mirrors the Prometheus model (counter / gauge / histogram) so the same
instrumentation calls compile to real Prometheus clients in production. The
histogram keeps raw observations here because the reference run is bounded;
production uses fixed-bucket histograms so quantiles aggregate correctly
across replicas.

The domain SLIs are the ones that matter for evaluation, not the RED
mechanics: time-to-first-assignment, first-arrival latency, deadline-miss
rate, reassignment churn, unserved incidents.
"""
from __future__ import annotations

import threading
from collections import defaultdict
from typing import Dict, List

import math


class Histogram:
    __slots__ = ("values",)

    def __init__(self) -> None:
        self.values: List[float] = []

    def observe(self, v: float) -> None:
        self.values.append(v)

    def quantile(self, q: float) -> float:
        if not self.values:
            return float("nan")
        s = sorted(self.values)
        idx = min(len(s) - 1, max(0, int(math.ceil(q * len(s))) - 1))
        return s[idx]

    def mean(self) -> float:
        return (sum(self.values) / len(self.values)) if self.values else float("nan")

    def __len__(self) -> int:
        return len(self.values)


class Metrics:
    def __init__(self) -> None:
        self._counters: Dict[str, float] = defaultdict(float)
        self._gauges: Dict[str, float] = {}
        self._hists: Dict[str, Histogram] = defaultdict(Histogram)
        self._lock = threading.RLock()

    def incr(self, name: str, by: float = 1.0) -> None:
        with self._lock:
            self._counters[name] += by

    def gauge(self, name: str, value: float) -> None:
        with self._lock:
            self._gauges[name] = value

    def observe(self, name: str, value: float) -> None:
        with self._lock:
            self._hists[name].observe(value)

    def counter(self, name: str) -> float:
        return self._counters.get(name, 0.0)

    def hist(self, name: str) -> Histogram:
        return self._hists[name]

    def snapshot(self) -> Dict[str, object]:
        with self._lock:
            return {
                "counters": dict(self._counters),
                "gauges": dict(self._gauges),
                "histograms": {
                    k: {
                        "n": len(h),
                        "mean": h.mean(),
                        "p50": h.quantile(0.50),
                        "p90": h.quantile(0.90),
                        "p99": h.quantile(0.99),
                    }
                    for k, h in self._hists.items()
                },
            }
