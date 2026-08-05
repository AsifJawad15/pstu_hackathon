"""
Circuit breaker.

Guards every synchronous call to a dependency that is not on the critical
correctness path (routing, geocoding, notification, weather). When a
dependency degrades, failing fast and taking the documented fallback is
strictly better than queueing threads against a dying service and turning a
partial outage into a total one.
"""
from __future__ import annotations

import threading
from typing import Any, Callable

CLOSED, OPEN, HALF_OPEN = "closed", "open", "half_open"


class CircuitOpen(Exception):
    pass


class CircuitBreaker:
    def __init__(self, failure_threshold: int = 5, reset_timeout_s: float = 30.0,
                 half_open_successes: int = 2) -> None:
        self.failure_threshold = failure_threshold
        self.reset_timeout_s = reset_timeout_s
        self.half_open_successes = half_open_successes
        self._state = CLOSED
        self._failures = 0
        self._successes = 0
        self._opened_at = 0.0
        self._lock = threading.RLock()
        self.trips = 0

    @property
    def state(self) -> str:
        return self._state

    def call(self, fn: Callable[..., Any], *args, now: float = 0.0, **kwargs) -> Any:
        with self._lock:
            if self._state == OPEN:
                if now - self._opened_at >= self.reset_timeout_s:
                    self._state = HALF_OPEN
                    self._successes = 0
                else:
                    raise CircuitOpen("circuit open")
        try:
            result = fn(*args, **kwargs)
        except Exception:
            self._on_failure(now)
            raise
        self._on_success()
        return result

    def _on_success(self) -> None:
        with self._lock:
            if self._state == HALF_OPEN:
                self._successes += 1
                if self._successes >= self.half_open_successes:
                    self._state = CLOSED
                    self._failures = 0
            else:
                self._failures = 0

    def _on_failure(self, now: float) -> None:
        with self._lock:
            self._failures += 1
            if self._state == HALF_OPEN or self._failures >= self.failure_threshold:
                if self._state != OPEN:
                    self.trips += 1
                self._state = OPEN
                self._opened_at = now
