"""
Command-side state store.

Models the three mechanisms that make concurrent dispatch safe, which in
production map to PostgreSQL + Redis:

* **Optimistic concurrency (`version` CAS).** Every mutation carries the
  version it read. `UPDATE ... WHERE id=? AND version=?` returning 0 rows is
  a lost update, and the caller retries. Chosen over pessimistic row locks
  because dispatch conflicts are rare but lock convoys under surge are fatal.

* **Reservation leases.** A resource is soft-reserved with a TTL before the
  assignment is committed. If the optimizer crashes mid-commit, the lease
  expires and the resource returns to the pool automatically. Without a TTL
  a crash would strand ambulances indefinitely - a correctness bug that is
  invisible in testing and catastrophic in production.

* **Transactional outbox.** State change and the event announcing it are
  written in one atomic unit; a relay publishes afterwards. This removes the
  dual-write race where a resource is marked busy but the assignment event is
  never emitted (or vice versa).

Multi-resource incidents make reservation an all-or-nothing group operation,
so `reserve_all` is a small saga with compensation.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from ..domain.models import (Assignment, AssignmentState, Incident, Resource,
                             ResourceState)


class ConcurrencyError(Exception):
    """Raised on a failed compare-and-swap; caller must re-read and retry."""


class ReservationDenied(Exception):
    pass


@dataclass
class Lease:
    resource_id: str
    holder: str
    expires_at: float
    token: str


@dataclass
class OutboxRecord:
    topic: str
    key: str
    payload: Dict[str, object]
    ts: float
    published: bool = False


class StateStore:
    def __init__(self, lease_ttl_s: float = 30.0, metrics=None) -> None:
        self.incidents: Dict[str, Incident] = {}
        self.resources: Dict[str, Resource] = {}
        self.assignments: Dict[str, Assignment] = {}
        self.leases: Dict[str, Lease] = {}
        self.outbox: List[OutboxRecord] = []
        #: Append-only decision journal - the audit + replay substrate.
        self.decision_log: List[Dict[str, object]] = []
        self._processed: Dict[str, str] = {}      # idempotency key -> result id
        self._lock = threading.RLock()
        self.lease_ttl_s = lease_ttl_s
        self.metrics = metrics
        self.cas_conflicts = 0
        self.lease_expiries = 0
        self.double_book_attempts = 0
        self._token_seq = 0

    # -- registration -------------------------------------------------------

    def put_resource(self, r: Resource) -> None:
        with self._lock:
            self.resources[r.resource_id] = r

    def put_incident(self, i: Incident) -> None:
        with self._lock:
            self.incidents[i.incident_id] = i

    # -- idempotency --------------------------------------------------------

    def seen(self, idem_key: str) -> Optional[str]:
        with self._lock:
            return self._processed.get(idem_key)

    def remember(self, idem_key: str, result_id: str) -> None:
        with self._lock:
            self._processed[idem_key] = result_id

    # -- leases -------------------------------------------------------------

    def _next_token(self) -> str:
        self._token_seq += 1
        return f"LEASE-{self._token_seq:09d}"

    def try_reserve(self, resource_id: str, holder: str, now: float,
                    expected_version: Optional[int] = None) -> Lease:
        """
        Atomically: check the resource is free, check the CAS token, take a
        TTL lease and flip the state to RESERVED. This is the single point
        where double-booking is prevented; every dispatch path goes through
        it.
        """
        with self._lock:
            res = self.resources.get(resource_id)
            if res is None:
                raise ReservationDenied(f"unknown resource {resource_id}")

            existing = self.leases.get(resource_id)
            if existing is not None:
                if existing.expires_at > now:
                    self.double_book_attempts += 1
                    if self.metrics:
                        self.metrics.incr("reservation.denied.leased")
                    raise ReservationDenied(f"{resource_id} leased by {existing.holder}")
                # expired lease - reclaim
                self.lease_expiries += 1
                del self.leases[resource_id]
                if res.state == ResourceState.RESERVED:
                    res.state = ResourceState.AVAILABLE
                    res.version += 1

            if expected_version is not None and res.version != expected_version:
                self.cas_conflicts += 1
                if self.metrics:
                    self.metrics.incr("reservation.denied.cas")
                raise ConcurrencyError(
                    f"{resource_id} version {res.version} != expected {expected_version}")

            if res.state != ResourceState.AVAILABLE:
                self.double_book_attempts += 1
                if self.metrics:
                    self.metrics.incr("reservation.denied.state")
                raise ReservationDenied(f"{resource_id} is {res.state.value}")

            lease = Lease(resource_id=resource_id, holder=holder,
                          expires_at=now + self.lease_ttl_s, token=self._next_token())
            self.leases[resource_id] = lease
            res.state = ResourceState.RESERVED
            res.version += 1
            if self.metrics:
                self.metrics.incr("reservation.granted")
            return lease

    def reserve_all(self, resource_ids: Sequence[str], holder: str, now: float) -> List[Lease]:
        """
        All-or-nothing group reservation (saga with compensation).

        A collapsed building needing 2 ambulances + 1 rescue team must not end
        up with a rescue team held hostage while the ambulances went elsewhere:
        partial allocation both wastes the unit and hides the shortfall from
        the operator.
        """
        acquired: List[Lease] = []
        try:
            for rid in resource_ids:
                acquired.append(self.try_reserve(rid, holder, now))
            return acquired
        except (ReservationDenied, ConcurrencyError):
            for lease in acquired:                     # compensate
                self.release(lease.resource_id, lease.token, now)
            if self.metrics:
                self.metrics.incr("reservation.group.rolled_back")
            raise

    def release(self, resource_id: str, token: str, now: float,
                new_state: ResourceState = ResourceState.AVAILABLE) -> bool:
        """Fencing-token release: a stale holder cannot free somebody else's lease."""
        with self._lock:
            lease = self.leases.get(resource_id)
            if lease is None or lease.token != token:
                return False
            del self.leases[resource_id]
            res = self.resources.get(resource_id)
            if res is not None and res.state == ResourceState.RESERVED:
                res.state = new_state
                res.version += 1
            return True

    def reap_expired_leases(self, now: float) -> int:
        """Background reaper - the reason an optimizer crash cannot strand units."""
        with self._lock:
            dead = [rid for rid, l in self.leases.items() if l.expires_at <= now]
            for rid in dead:
                del self.leases[rid]
                res = self.resources.get(rid)
                if res is not None and res.state == ResourceState.RESERVED:
                    res.state = ResourceState.AVAILABLE
                    res.version += 1
                self.lease_expiries += 1
            if dead and self.metrics:
                self.metrics.incr("reservation.reaped", len(dead))
            return len(dead)

    # -- CAS ----------------------------------------------------------------

    def update_resource(self, resource_id: str, expected_version: int,
                        mutate: Callable[[Resource], None]) -> Resource:
        with self._lock:
            res = self.resources[resource_id]
            if res.version != expected_version:
                self.cas_conflicts += 1
                raise ConcurrencyError(f"{resource_id} CAS failed")
            mutate(res)
            res.version += 1
            return res

    # -- outbox -------------------------------------------------------------

    def commit(self, assignment: Assignment, events: Sequence[Tuple[str, str, Dict[str, object]]],
               now: float) -> None:
        """Single critical section: persist the assignment and stage its events."""
        with self._lock:
            self.assignments[assignment.assignment_id] = assignment
            for topic, key, payload in events:
                self.outbox.append(OutboxRecord(topic=topic, key=key, payload=payload, ts=now))

    def relay(self, publish: Callable[[str, str, Dict[str, object], float], object]) -> int:
        with self._lock:
            pending = [r for r in self.outbox if not r.published]
        for rec in pending:
            publish(rec.topic, rec.key, rec.payload, rec.ts)
            rec.published = True
        return len(pending)

    # -- decision journal ---------------------------------------------------

    def journal(self, record: Dict[str, object]) -> None:
        with self._lock:
            self.decision_log.append(record)

    # -- queries ------------------------------------------------------------

    def live_assignments_for(self, incident_id: str) -> List[Assignment]:
        return [a for a in self.assignments.values()
                if a.incident_id == incident_id and a.is_live()]

    def live_assignment_of(self, resource_id: str) -> Optional[Assignment]:
        for a in self.assignments.values():
            if a.resource_id == resource_id and a.is_live():
                return a
        return None

    def integrity_check(self) -> List[str]:
        """
        Invariant audit. Any violation here is a resource conflict, which the
        problem statement lists as a hard requirement, so it is asserted
        rather than merely monitored.
        """
        problems: List[str] = []
        seen: Dict[str, str] = {}
        for a in self.assignments.values():
            if not a.is_live():
                continue
            if a.resource_id in seen:
                problems.append(
                    f"DOUBLE-BOOK {a.resource_id}: {seen[a.resource_id]} and {a.assignment_id}")
            seen[a.resource_id] = a.assignment_id
        for r in self.resources.values():
            if r.state in (ResourceState.EN_ROUTE, ResourceState.ON_SCENE,
                           ResourceState.TRANSPORTING) and r.current_assignment is None:
                problems.append(f"ORPHAN busy resource {r.resource_id} state={r.state.value}")
            if r.occupied > r.capacity:
                problems.append(f"OVER-CAPACITY {r.resource_id}: {r.occupied}/{r.capacity}")
        return problems
