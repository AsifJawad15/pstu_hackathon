# Final Ten-Stage Build Plan for the Emergency Response Platform

## Mission and production targets

Build a hybrid-sovereign, country-wide emergency response platform as ten sequential, independently gated modules. Project initialization is a prerequisite and is not counted as a stage. Every stage must deliver working code, tests, observability, documentation, and a passing exit gate.

- Zero externally visible double assignment of exclusive resources.
- Regional critical-path availability of at least 99.999%.
- Regional durable acceptance p99 at or below 50 ms.
- Candidate lookup and feasible allocation p99 at or below 100 ms.
- Complete allocation and reservation p99 at or below 250 ms.
- Dispatch enqueue after commitment p99 at or below 25 ms.
- Material-change re-optimization p99 at or below 500 ms.
- Regional continuity during national-layer or WAN failure.

## Project initialization — not a stage

Create a monorepo containing backend services, versioned contracts, operator console, infrastructure definitions, simulation tools, tests, and architecture documentation. Establish reproducible local and container builds, database migrations, fixtures, static analysis, dependency locking, CI, SBOM generation, signed artifacts, feature flags, bounded inputs and queues, explicit deadlines, idempotent handlers, structured errors, and cancellation propagation. Initialization passes when the skeleton starts, health checks work, migrations and contracts validate, and CI passes.

## Fixed contracts

The platform exposes versioned operations for incident report/update/cancel, resource telemetry/state, facility capacity, environmental updates, reservations, dispatch and acknowledgements, decision explanations, operator overrides, and authorized public warnings. Every event carries identity, correlation, causation and idempotency IDs; schema and aggregate versions; policy, map, resource and shard epochs; source/effective/ingestion/expiry times; geography; confidence; authority; trace ID; and signature metadata. Evolution is backward-compatible and unknown mandatory semantics fail closed.

## Stage 1 — Domain model, safety invariants, and policy

Define incident, resource, facility, assignment, dispatch, notification, transfer and audit state machines; P0–P3 priorities; hard safety constraints; provisional versus durable assignment; version checks; reason codes; signed versioned policy; threat model; privacy classification; and human authority. Exit when invalid transitions are property-tested, policy evaluation is deterministic, hard constraints have boundary coverage, contracts are compatible, and domain owners approve the lifecycle.

## Stage 2 — Regional intake and edge continuity

Implement active-active regional intake, local credential and policy validation, schema and replay protection, priority-isolated bounded queues, durable `ACCEPTED` acknowledgements, encrypted `RECEIVED_DEGRADED` edge spooling, reconciliation, idempotency, and per-source admission control. Exit when p99 acceptance is at most 50 ms, duplicates yield one incident, telemetry cannot starve P0, offline reconciliation works, and malicious inputs fail safely.

## Stage 3 — Operational data, events, and sharding

Use PostgreSQL/PostGIS as operational authority, Kafka for at-least-once events and replay, etcd for shard/leader epochs, and disposable caches for projections. Create 256 virtual shards per region, route incidents and resources by stable hashes, implement transactional outbox, consumer deduplication, poison-event quarantine, deterministic rebuilds, a versioned shard directory, and safe resharding states. Exit when projections rebuild, broker loss cannot lose database events, duplicates have no repeated effect, cache loss is survivable, and routing is balanced and deterministic.

## Stage 4 — Resource state, geospatial search, and routing

Process ordered telemetry with freshness and confidence, index local candidates by regional spatial cells, use expanding-ring search, host local maps, cache travel matrices, apply versioned hazards and closures, retain a rollback graph, use conservative ETA fallback, and model stale-location uncertainty. Exit when lookup meets p99 20 ms, old telemetry never overwrites new state, route failure degrades safely, closed routes are excluded, and projection rebuilds are stable.

## Stage 5 — Deterministic feasible-first allocation

Prioritize using severity, time-to-harm, population, vulnerability, environmental escalation and confidence, with hard policy above scoring. Filter every hard constraint; score ETA, route risk, scarcity, coverage loss and handover cost; produce a stable greedy/min-cost-flow incumbent; explicitly report no feasible resource; and persist complete explanations. Exit when allocation meets p99 100 ms, identical inputs match, no hard constraint is violated, representative geographic and scarcity scenarios pass, and cached routing works without shared cache.

## Stage 6 — Strong reservation and multi-channel dispatch

Implement atomic versioned holds, monotonic fencing tokens, deterministic multi-resource hold order, idempotent compensation, durable accepted assignments, atomic assignment/command/outbox writes, signed commands, stale-epoch rejection, parallel critical channels, and explicit responder states. Exit when concurrent claims have one winner, crash-boundary tests lose no command, stale commands fail, allocation plus reservation meets p99 250 ms, enqueue meets p99 25 ms, and channel failover starts within five seconds.

## Stage 7 — Bounded optimization and communications

Run deadline-bound improvement over the feasible incumbent; re-optimize only material changes; enforce stickiness, improvement thresholds, freeze windows, redirect limits, confidence and commitment horizons; require operators for high-impact changes; and implement recipient resolution, expiry, supersession, cancellation, localization, acknowledgement, escalation and authorized CAP-compatible warnings. Exit when re-optimization meets p99 500 ms or preserves the current plan, optimizer termination is harmless, thrashing is prevented, obsolete warnings are suppressed, callbacks are idempotent, and overrides remain auditable.

## Stage 8 — HA, replication, resharding, and disaster recovery

Spread each cell across three fault domains. Use PostgreSQL primary plus two synchronous standbys, Kafka RF3/min-ISR2, five etcd members distributed 2/2/1, three stateless replicas with N+2 capacity, asynchronous paired-region events/WAL, fenced takeover, replication-watermark quarantine, partition-safe transfer rules, immutable archives, daily backups, 35-day PITR and verified restore exercises. Exit when process recovery is at most 2 s, leader recovery 10 s, regional takeover 60 s after fencing, paired RPO 5 s, backup RPO 5 min/RTO 30 min per shard, and split brain is impossible.

## Stage 9 — Security, observability, operator control, and readiness

Use workload/device mTLS, hardware-backed command keys, OIDC and phishing-resistant MFA, jurisdiction-aware access, audited break-glass, network segmentation, DDoS controls, signed builds and SBOMs, privacy controls, end-to-end OpenTelemetry, outcome-focused SLOs, an EOC console, failure runbooks, synthetic P0 probes, canaries and automated rollback. Exit when critical security findings are closed, consequential actions are immutable and traceable, operators complete degraded workflows, alerts are actionable, and key rotation works under load.

## Stage 10 — Full validation, pilot, and competition delivery

Execute unit, property, contract, replay, concurrency, load, soak, skew, chaos, network, DR, security, privacy and human-factor tests. Validate 50,000 events/s per busy cell, 10× 60-second bursts and 150,000 national notification attempts/s, including one fault domain unavailable. Pilot regionally, expand only through evidence-based gates, retain manual continuity, and feed after-action results into controlled releases.

Production acceptance requires zero double assignment and invalid transitions, no acknowledged critical loss from one-domain failure, regional autonomy, deterministic fallback without optimizer/cache/live routing, fenced recovery, verified restores, complete explanations, and latency/availability compliance under failure load.

The competition package derives from this evidence: a registration-ID PDF abstract of no more than 250 words and 10 MB, plus a registration-ID MP4 of no more than four minutes and 400 MB. It must contain no team, member, university or institution names and must distinguish demonstrator capability from the production roadmap.

## Assumptions

- Regional government or telecom infrastructure runs the emergency path; national/cloud services provide federation and analytics.
- Regional fault domains are close enough for synchronous critical commits.
- Safety and ownership consistency outrank ambiguous availability.
- Regions remain autonomous and suspend cross-region optimization during WAN partitions.
- Public-network human acknowledgement is measured but not guaranteed.
- Public warnings require explicit emergency-authority approval.
- Code completion never passes a stage without tests, operating evidence, and documentation.

