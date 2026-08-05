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

Health endpoints:

- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`

Primary API endpoints are documented in [docs/api.md](./docs/api.md).

## Safety boundary

This is an engineering reference implementation, not a certified medical or public-warning system. Real deployment requires emergency-authority policy approval, audited telecom integrations, HSM-backed keys, three independent fault domains, security assessment, capacity evidence, and disaster exercises.
