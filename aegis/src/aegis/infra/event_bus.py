"""
Partitioned, at-least-once event log.

An in-process stand-in for Kafka/Redpanda that preserves the properties the
architecture actually depends on, so the reference implementation exercises
the same failure modes as production:

* **Per-partition ordering.** Partition key is the region id, so all events
  for one region are totally ordered and one optimizer worker owns them.
  Cross-region ordering is not required and is not paid for.
* **At-least-once delivery with retry and DLQ.** Handlers must therefore be
  idempotent; see `infra.idempotency`.
* **Offsets and lag.** Autoscaling in AEGIS keys on consumer lag, not CPU,
  because lag is the metric that actually correlates with dispatch delay.
"""
from __future__ import annotations

import threading
import zlib
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple


@dataclass
class Event:
    topic: str
    key: str
    payload: Dict[str, Any]
    ts: float
    event_id: str
    attempts: int = 0
    headers: Dict[str, str] = field(default_factory=dict)


Handler = Callable[[Event], None]


class EventBus:
    def __init__(self, partitions: int = 16, max_attempts: int = 3, metrics=None) -> None:
        self.partitions = partitions
        self.max_attempts = max_attempts
        self.metrics = metrics
        self._log: Dict[Tuple[str, int], Deque[Event]] = defaultdict(deque)
        self._handlers: Dict[str, List[Handler]] = defaultdict(list)
        self.dlq: List[Tuple[Event, str]] = []
        self._lock = threading.RLock()
        self._seq = 0
        self.published = 0
        self.delivered = 0
        self.retried = 0

    def partition_for(self, key: str) -> int:
        return zlib.crc32(key.encode()) % self.partitions

    def subscribe(self, topic: str, handler: Handler) -> None:
        self._handlers[topic].append(handler)

    def publish(self, topic: str, key: str, payload: Dict[str, Any], ts: float,
                headers: Optional[Dict[str, str]] = None) -> Event:
        with self._lock:
            self._seq += 1
            ev = Event(topic=topic, key=key, payload=payload, ts=ts,
                       event_id=f"EVT-{self._seq:09d}", headers=headers or {})
            self._log[(topic, self.partition_for(key))].append(ev)
            self.published += 1
        if self.metrics:
            self.metrics.incr(f"bus.published.{topic}")
        return ev

    def lag(self) -> int:
        with self._lock:
            return sum(len(q) for q in self._log.values())

    def lag_by_topic(self) -> Dict[str, int]:
        out: Dict[str, int] = defaultdict(int)
        with self._lock:
            for (topic, _), q in self._log.items():
                out[topic] += len(q)
        return dict(out)

    def drain(self, budget: Optional[int] = None) -> int:
        """
        Deliver pending events. Partitions are polled round-robin so a single
        hot region cannot starve the rest of the country - the same fairness
        property a bounded `max.poll.records` gives in Kafka.
        """
        processed = 0
        while True:
            with self._lock:
                keys = [k for k, q in self._log.items() if q]
            if not keys:
                break
            for k in keys:
                with self._lock:
                    q = self._log[k]
                    if not q:
                        continue
                    ev = q.popleft()
                handlers = self._handlers.get(ev.topic, ())
                for h in handlers:
                    try:
                        h(ev)
                        self.delivered += 1
                    except Exception as exc:                     # noqa: BLE001
                        ev.attempts += 1
                        if ev.attempts < self.max_attempts:
                            self.retried += 1
                            with self._lock:
                                self._log[k].append(ev)
                            if self.metrics:
                                self.metrics.incr("bus.retry")
                        else:
                            self.dlq.append((ev, repr(exc)))
                            if self.metrics:
                                self.metrics.incr("bus.dlq")
                        break
                processed += 1
                if budget is not None and processed >= budget:
                    return processed
        return processed
