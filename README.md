# Emergency Response Platform

This repository contains a runnable reference implementation and production deployment blueprint for the ten-stage emergency response plan in [plan.md](./plan.md).

## Quick start

Requirements: Node.js 24 or newer.

```powershell
Copy-Item .env.example .env
npm install
npm test
npm start
```

The local runtime uses Node's built-in SQLite module and in-process adapters so safety behavior can be tested without external infrastructure. Production manifests target PostgreSQL/PostGIS, Kafka, etcd, Redis, a local routing service, and Kubernetes.

Default local URL: `http://127.0.0.1:8181`.

An evaluator can run a self-contained black-box acceptance suite without importing internal code:

```powershell
npm run evaluate:isolated
```

The editable evaluator cases and external-instance instructions are in [evaluation/README.md](./evaluation/README.md).

For a complete judge-facing walkthrough of every test available in the web console, see [docs/interface-testing.md](./docs/interface-testing.md).

## Full production-architecture demonstration

Docker Compose starts the API, PostgreSQL/PostGIS, a three-broker Kafka quorum, Redis, a three-member etcd quorum, Prometheus, and Grafana. Setup, judge walkthrough, independent evidence, and controlled failure drills are in [docs/production-demo.md](./docs/production-demo.md).

```powershell
npm run secrets:rotate
npm run docker:up
npm run docker:smoke
```

Health endpoints:

- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`

Primary API endpoints are documented in [docs/api.md](./docs/api.md).

The latest external design report was reconciled against the repository in [docs/redesign-reconciliation.md](./docs/redesign-reconciliation.md). Production promotion and rollback rules are in [docs/deployment-safety.md](./docs/deployment-safety.md).

## Safety boundary

This is an engineering reference implementation, not a certified medical or public-warning system. Real deployment requires emergency-authority policy approval, audited telecom integrations, HSM-backed keys, three independent fault domains, security assessment, capacity evidence, and disaster exercises.
