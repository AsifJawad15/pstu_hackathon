# Senior-engineering redesign reconciliation

Reviewed source: `deep-research-report (1).md`, supplied 5 August 2026.

## Corrected current state

The supplied report says the repository was unavailable, so its current-state section is necessarily hypothetical. This repository is now directly verified. It has authenticated bounded intake, SQLite reference persistence, a PostgreSQL/PostGIS production schema, a transactional outbox, consumer deduplication, 256 virtual shards, deterministic allocation, atomic fenced reservations, facility-capacity accounting, local route fallback, signed dispatch commands, reactive re-optimization, encrypted edge spooling, an audit hash chain, Kubernetes topology controls, CI, and automated tests.

SQLite and in-memory providers are demonstrator adapters. They do not prove the production availability, throughput, telecom, recovery, or regulatory claims in `plan.md`.

## Changes adopted from the report

| Recommendation | Repository action |
|---|---|
| Time-sortable durable IDs | Added RFC 9562 UUIDv7 generation for incidents, decisions, assignments, commands, warnings, outbox records, attempts and audit events. |
| Provider isolation | Added independent circuit state per provider with fail-fast alternate-provider routing. |
| Retry control | Added capped exponential full-jitter planning that honors provider `Retry-After` without sleeping in the request path. |
| Ambiguous timeout safety | Added provider status reconciliation before fallback when submission outcome is unknown. |
| Callback correctness | Added event deduplication and monotonic status reduction so late callbacks cannot move delivery backward. |
| Delivery evidence | Added notification job, attempt and provider-status tables to the production schema and attempt evidence to the local runtime. |
| Safety verification | Added executable PostgreSQL queries for double assignments, multiple owners, expired live jobs and fencing mismatch. |
| Workload priority | Added a P0 Kubernetes `PriorityClass`, startup health protection, and queue-age/outbox HPA signals. |
| Outcome observability | Added alert rules for P0 queue age, unassigned P0 incidents, channel redundancy, ownership conflict and outbox age. |
| Safe delivery | Added shadow/canary promotion, invariant-based rollback, expand-migrate-contract, warm rollback and emergency freeze rules. |

## Decisions deliberately clarified

- PostgreSQL remains the admission authority. `ACCEPTED` follows the regional durable transaction; Kafka receives its event through the transactional outbox. This avoids a broker/database dual-write and preserves deterministic reconstruction.
- The system keeps 256 virtual shards but begins with one physical, synchronously replicated PostgreSQL cluster per region. Secondary physical sharding is evidence-triggered, not assumed on day one.
- The 50/100/250 ms plan targets are internal regional budgets. External carrier delivery and responder acknowledgement are separate SLOs because public networks and people cannot provide a deterministic backend bound.
- Provider retry is durable and asynchronous. The intake or dispatch transaction never waits through exponential backoff.
- Cross-region replication remains asynchronous; takeover requires fencing and uncertainty quarantine. WAN consensus is not added to the normal regional dispatch path.

## Still external or incomplete

Production approval still requires real PostgreSQL/Kafka/etcd clusters in three fault domains, HSM/KMS custody, signed provider webhooks, real SMS/push/radio adapters, OpenTelemetry export and dashboards, local H3/routing production adapters, load and chaos evidence, point-in-time restore exercises, a paired-region takeover drill, security review, and operator pilot approval. These are exit gates, not claims made by this demonstrator.
