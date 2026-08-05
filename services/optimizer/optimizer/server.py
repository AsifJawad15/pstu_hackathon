"""Minimal authenticated HTTP boundary for the Python optimizer."""
from __future__ import annotations

import hmac
import json
import os
import signal
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict

from aegis.core.matching import objective, solve_assignment

from .solver import InvalidOptimizationRequest, solve_bundle


MAX_BODY_BYTES = 256 * 1024
MAX_CONCURRENT_SOLVES = max(
    1, min(int(os.environ.get("OPTIMIZER_MAX_CONCURRENCY", "4")), 32)
)
SOLVE_SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT_SOLVES)
METRICS_LOCK = threading.Lock()
METRICS: Dict[str, int] = {"requests": 0, "solves": 0, "rejected": 0, "errors": 0}


class OptimizerHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64


class Handler(BaseHTTPRequestHandler):
    server_version = "AegisOptimizer/1.0"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(2.0)

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/health/live", "/health/ready"):
            self._json(HTTPStatus.OK, {
                "status": "READY", "service": "aegis-python-optimizer",
                "solverVersion": "aegis-bundle-1", "maxConcurrency": MAX_CONCURRENT_SOLVES,
            })
            return
        if self.path == "/metrics":
            with METRICS_LOCK:
                snapshot = dict(METRICS)
            lines = [f'aegis_optimizer_{name}_total {value}' for name, value in snapshot.items()]
            self._send(HTTPStatus.OK, "\n".join(lines) + "\n", "text/plain; version=0.0.4")
            return
        self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Route not found")

    def do_POST(self) -> None:  # noqa: N802
        self._increment("requests")
        if self.path not in ("/v1/solve/bundle", "/v1/solve/matrix"):
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Route not found")
            return
        if not self._authenticated():
            self._error(HTTPStatus.UNAUTHORIZED, "UNAUTHENTICATED", "Optimizer token required")
            return
        if not SOLVE_SLOTS.acquire(blocking=False):
            self._increment("rejected")
            self._error(HTTPStatus.SERVICE_UNAVAILABLE, "OPTIMIZER_OVERLOADED", "Optimizer concurrency limit reached")
            return
        try:
            body = self._read_json()
            if self.path == "/v1/solve/bundle":
                result = solve_bundle(body)
            else:
                result = self._solve_matrix(body)
            self._increment("solves")
            self._json(HTTPStatus.OK, result)
        except InvalidOptimizationRequest as error:
            self._error(HTTPStatus.UNPROCESSABLE_ENTITY, "INVALID_OPTIMIZATION_REQUEST", str(error))
        except Exception:  # keep internal details out of the response
            self._increment("errors")
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "OPTIMIZER_ERROR", "Optimization could not be completed")
        finally:
            SOLVE_SLOTS.release()

    def _solve_matrix(self, body: Dict[str, Any]) -> Dict[str, Any]:
        matrix = body.get("costMatrix")
        if not isinstance(matrix, list) or not matrix or len(matrix) > 128:
            raise InvalidOptimizationRequest("costMatrix must contain 1 to 128 rows")
        width = len(matrix[0]) if isinstance(matrix[0], list) else 0
        if width < 1 or width > 128 or any(not isinstance(row, list) or len(row) != width for row in matrix):
            raise InvalidOptimizationRequest("costMatrix must be rectangular with 1 to 128 columns")
        costs = []
        for row in matrix:
            parsed = []
            for value in row:
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not -1e8 <= value <= 1e12:
                    raise InvalidOptimizationRequest("costMatrix contains an invalid cost")
                parsed.append(float(value))
            costs.append(parsed)
        pairs = solve_assignment(costs)
        return {
            "schemaVersion": 1, "solverVersion": "aegis-matching-1",
            "algorithm": "JONKER_VOLGENANT", "pairs": pairs,
            "objective": objective(costs, pairs),
        }

    def _read_json(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError as error:
            raise InvalidOptimizationRequest("Content-Length is invalid") from error
        if length < 1 or length > MAX_BODY_BYTES:
            raise InvalidOptimizationRequest("Request body must contain 1 to 262144 bytes")
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise InvalidOptimizationRequest("Request body must be valid JSON") from error
        if not isinstance(value, dict):
            raise InvalidOptimizationRequest("Request body must be an object")
        return value

    def _authenticated(self) -> bool:
        expected = os.environ.get("OPTIMIZER_SHARED_SECRET", "")
        supplied = self.headers.get("x-optimizer-token", "")
        return bool(expected) and hmac.compare_digest(expected, supplied)

    def _json(self, status: HTTPStatus, payload: Dict[str, Any]) -> None:
        self._send(status, json.dumps(payload, separators=(",", ":")), "application/json; charset=utf-8")

    def _error(self, status: HTTPStatus, code: str, message: str) -> None:
        self._json(status, {"error": {"code": code, "message": message}})

    def _send(self, status: HTTPStatus, body: str, content_type: str) -> None:
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(encoded)))
        self.send_header("x-content-type-options", "nosniff")
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    @staticmethod
    def _increment(name: str) -> None:
        with METRICS_LOCK:
            METRICS[name] += 1

    def log_message(self, fmt: str, *args: Any) -> None:
        print(json.dumps({"level": "info", "event": "optimizer_http", "message": fmt % args}))


def main() -> None:
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8090"))
    if not os.environ.get("OPTIMIZER_SHARED_SECRET"):
        raise SystemExit("OPTIMIZER_SHARED_SECRET is required")
    server = OptimizerHttpServer((host, port), Handler)
    def stop(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(json.dumps({"level": "info", "event": "optimizer_started", "host": host, "port": port}))
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
