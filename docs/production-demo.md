# Production Demonstration Runbook

This runbook turns the repository into a multi-service demonstration of the production architecture. It is designed so an evaluator can see normal operation, safety controls, replicated infrastructure, degradation, and recovery without reading source code.

## What the Docker environment proves

The stack runs real service processes, not decorative status cards:

- the regional API executes deterministic prioritization, allocation, atomic local reservations, signed dispatch commands, audit chaining, and a transactional outbox;
- PostgreSQL/PostGIS stores replayable integration events and the production relational/geospatial schema;
- three Kafka brokers use replication factor 3 and minimum in-sync replicas 2 for the critical topics;
- three etcd members maintain a quorum-backed regional ownership registration;
- Redis provides a disposable low-latency projection and can be lost without stopping regional decisions;
- Prometheus scrapes operational metrics every five seconds;
- Grafana loads a pre-provisioned regional reliability dashboard;
- the smoke evaluator verifies evidence independently through public APIs and direct dependency reads.

The laptop stack is a **production-architecture demonstration**, not a certified emergency deployment. SQLite remains the reference application's local transaction authority so the regional hot path can be demonstrated offline. The PostgreSQL schema, Kubernetes manifests, replication design, security controls, backup objectives, and three-fault-domain topology in `plan.md` are the production promotion path. A real authority must complete security accreditation, telecom/provider integration, HSM custody, multi-zone deployment, capacity testing, and disaster exercises.

## Requirements

- Docker Desktop running with Linux containers
- Docker Compose 2 or newer
- Node.js 24 or newer for local verification commands
- Recommended: 4 CPU cores, 8 GB free memory, and 15 GB free disk space

No database, Kafka, Redis, etcd, Prometheus, or Grafana installation is needed on the host.

## Start the complete platform

Run these commands from `E:\Hackathon\pstu`:

```powershell
npm install
npm run secrets:rotate
npm run check
npm run docker:up
npm run docker:status
```

Wait until `api`, `postgres`, all three Kafka brokers, Redis, and all three etcd members report healthy. The first start downloads pinned container images and can take several minutes.

Open:

- Command console: `http://127.0.0.1:8181`
- Grafana: `http://127.0.0.1:3000`
- Prometheus: `http://127.0.0.1:9090`

Copy the API token without displaying it:

```powershell
$apiToken = ((Get-Content .env | Where-Object { $_ -match '^EMERGENCY_API_TOKEN=' }) -replace '^EMERGENCY_API_TOKEN=', '').Trim()
$apiToken | Set-Clipboard
```

Paste it into **API token**, keep region `region-a`, and select **Connect**. For Grafana, use user `admin`; retrieve its password with the same pattern using `GRAFANA_ADMIN_PASSWORD`.

## Five-minute judge walkthrough

1. **Overview — safety objective.** Show the bounded ingest → prioritize → allocate → reserve → dispatch → adapt loop and the latency/safety objectives.
2. **Response lab — realistic decision.** Select **Prepare baseline**, then **Critical medical**. Point out the P0 classification, fenced assignment, decision mode, policy version, and route evidence.
3. **Dynamic conditions.** Select **Road collapse**, **Hospital saturation**, or **Vehicle failure**, followed by **Re-optimize**. The current commitment is preserved unless the bounded recommendation is materially better and operator approval is required.
4. **Evidence.** Select the created incident in **Recent incidents**. Expand **Raw API evidence** to show candidate exclusions, input versions, resource and shard epochs, and explanation reasons.
5. **Conflict safety.** In **Test guide**, select **Run guided validation**. It verifies readiness, resource ingestion, P0 allocation, explanation retrieval, stale-epoch rejection, and simultaneous claims through public HTTP endpoints.
6. **Production services.** In **Infrastructure**, show that PostgreSQL, Kafka, Redis, and etcd are read from the live backend topology—not hard-coded. Open Grafana to show request traffic, critical intake, integration state, and outbox backlog.
7. **Independent evidence.** Run `npm run docker:smoke`. It creates a fresh P0 incident, then verifies the same event path in PostgreSQL, Kafka, Redis, and etcd. Save the JSON PASS output as judging evidence.

## Failure demonstrations

Run one drill at a time. Wait approximately 5–10 seconds for the console status to refresh.

### Redis loss: disposable cache, uninterrupted decisions

```powershell
docker compose stop redis
```

The Redis card becomes `DOWN`, while incident acceptance and deterministic allocation continue from authoritative/local state. Restore it:

```powershell
docker compose start redis
```

### One Kafka broker loss: quorum continues

```powershell
docker compose stop kafka-3
```

Create another critical incident. Kafka still has two in-sync replicas, so publication continues. Restore the broker:

```powershell
docker compose start kafka-3
```

### Kafka quorum loss: retain, recover, replay

```powershell
docker compose stop kafka-2 kafka-3
```

Create an incident. The regional transaction remains accepted, but the Kafka card becomes `DOWN` and **Event backlog** increases because the transactional outbox does not falsely mark publication complete. Recover the quorum and replay:

```powershell
docker compose start kafka-2 kafka-3
```

After both brokers are healthy, select **Retry retained events** in the console. The backlog returns to zero.

### PostgreSQL integration loss: local continuity

```powershell
docker compose stop postgres
```

The regional safety path remains available and retains unpublished events locally. Restore PostgreSQL, wait for it to become healthy, then select **Retry retained events**:

```powershell
docker compose start postgres
```

### etcd quorum loss: visible ownership degradation

```powershell
docker compose stop etcd-2 etcd-3
```

The ownership card becomes `DOWN`. Existing regional state remains readable, but a production controller must block ambiguous cross-region ownership transfer until fencing is re-established. Restore quorum:

```powershell
docker compose start etcd-2 etcd-3
```

## Ten-stage evidence map

| Build stage | Judge-visible proof | Automated evidence |
|---|---|---|
| 1. Domain and policy | P0 classification, explanation reasons, invalid action rejection | `npm test` policy/state-machine/property-style cases |
| 2. Regional intake | Fast authenticated incident submission and idempotent receipt | interface validation and isolated evaluator |
| 3. Data and sharding | Outbox count, PostgreSQL event row, Kafka topics, deterministic shard tests | `npm run docker:smoke`; sharding tests |
| 4. Resource and routing | Live resources, road-collapse scenario, safe route fallback | telemetry/order and routing tests |
| 5. Decision engine | Critical medical and mass-casualty allocations | deterministic feasibility test suite |
| 6. Reservation and dispatch | Exactly one claim winner, epochs, signed command evidence | guided validation and reservation stress test |
| 7. Re-optimization | Keep/redirect explanation after a material change | re-optimization and anti-thrashing tests |
| 8. Availability and recovery | Kafka/etcd quorum drills and retained-event replay | failure walkthrough plus Compose health checks |
| 9. Security and operations | bearer auth, audit integrity, CSP, metrics, Grafana | security headers/API tests and monitoring dashboard |
| 10. Full validation | independent black-box and dependency evidence | `npm run evaluate:isolated`; `npm run docker:smoke` |

## Independent acceptance commands

```powershell
npm run check
npm run evaluate:isolated
npm run stress:reservation
npm run benchmark
npm run docker:smoke
```

The evaluator source is intentionally included under `evaluation/` so a tester can modify inputs or write new black-box cases without importing application internals.

## Reset and stop

Stop containers while keeping durable volumes:

```powershell
npm run docker:down
```

To delete all demonstration data, use `docker compose down --volumes`. This is destructive and should only be run when the evidence is no longer needed.

## Production promotion requirements

Before any operational use, replace the reference authority with the PostgreSQL transactional adapter, use synchronous multi-zone database replicas, deploy five etcd members, place Kafka brokers across independent fault domains, enable mTLS/SASL and encrypted storage, use HSM/KMS-backed signing keys, integrate audited routing and communications providers, run the declared peak-plus-failure load tests, restore immutable backups, complete threat-model review, and obtain emergency-authority approval. The exact gates are defined in `plan.md`.
