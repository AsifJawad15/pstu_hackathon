"""
Versioned TTL cache with partition-scoped invalidation and stampede control.

Two properties matter for AEGIS and are not provided by a plain LRU:

* **Partition versioning.** When a bridge closes we must invalidate exactly
  the travel times touching that cell, not the entire matrix. Each entry
  records the partition version it was written under; a stale version is a
  miss without any scan or delete pass.
* **Single-flight / early expiry.** Under a surge, thousands of concurrent
  requests miss the same key simultaneously and all stampede the routing
  engine. Probabilistic early expiry (XFetch) staggers refreshes, and the
  in-flight set collapses duplicate recomputations.
"""
from __future__ import annotations

import math
import random
import threading
from collections import OrderedDict
from typing import Any, Dict, Hashable, Optional, Tuple


class VersionedTTLCache:
    def __init__(self, ttl_s: float = 60.0, max_entries: int = 100_000,
                 beta: float = 1.0, seed: int = 7) -> None:
        self.ttl_s = ttl_s
        self.max_entries = max_entries
        self.beta = beta
        self._data: "OrderedDict[Hashable, Tuple[Any, float, int, float]]" = OrderedDict()
        self._versions: Dict[Hashable, int] = {}
        self._inflight: set = set()
        self._lock = threading.RLock()
        self._rng = random.Random(seed)
        self.hits = 0
        self.misses = 0
        self.evictions = 0
        self.early_refreshes = 0

    # -- invalidation -------------------------------------------------------

    def bump_partition(self, partition: Hashable) -> int:
        with self._lock:
            v = self._versions.get(partition, 0) + 1
            self._versions[partition] = v
            return v

    def version(self, partition: Hashable) -> int:
        return self._versions.get(partition, 0)

    # -- access -------------------------------------------------------------

    def get(self, key: Hashable, partition: Hashable, now: float) -> Optional[Any]:
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                self.misses += 1
                return None
            value, written_at, version, delta = entry
            if version != self.version(partition):
                del self._data[key]
                self.misses += 1
                return None
            age = now - written_at
            # XFetch: refresh probabilistically before hard expiry so that
            # expiries of hot keys are spread out in time.
            if age >= self.ttl_s or (
                age > 0 and delta * self.beta * math.log(self._rng.random() or 1e-12) * -1 >= self.ttl_s - age
            ):
                if age < self.ttl_s:
                    self.early_refreshes += 1
                del self._data[key]
                self.misses += 1
                return None
            self._data.move_to_end(key)
            self.hits += 1
            return value

    def put(self, key: Hashable, value: Any, partition: Hashable, now: float,
            compute_cost_s: float = 0.02) -> None:
        with self._lock:
            self._data[key] = (value, now, self.version(partition), compute_cost_s)
            self._data.move_to_end(key)
            while len(self._data) > self.max_entries:
                self._data.popitem(last=False)
                self.evictions += 1

    # -- single flight ------------------------------------------------------

    def begin_compute(self, key: Hashable) -> bool:
        """Returns True if this caller owns the recomputation of `key`."""
        with self._lock:
            if key in self._inflight:
                return False
            self._inflight.add(key)
            return True

    def end_compute(self, key: Hashable) -> None:
        with self._lock:
            self._inflight.discard(key)

    # -- introspection ------------------------------------------------------

    def stats(self) -> Dict[str, float]:
        total = self.hits + self.misses
        return {
            "entries": len(self._data),
            "hits": self.hits,
            "misses": self.misses,
            "hit_rate": (self.hits / total) if total else 0.0,
            "evictions": self.evictions,
            "early_refreshes": self.early_refreshes,
        }
