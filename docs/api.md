# HTTP API

All `/v1` endpoints require `Authorization: Bearer <token>`. Production replaces the local bearer adapter with mTLS workload/device identity and OIDC operator identity. Bodies are JSON and limited to 256 KiB.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/system/snapshot` | Retrieve regional incident, resource, assignment, facility and event-backlog summary |
| GET | `/v1/platform/topology` | Retrieve live PostgreSQL, Kafka, Redis and etcd integration state |
| POST | `/v1/incidents` | Validate, durably accept and optionally allocate an incident |
| POST | `/v1/incidents/{id}/update` | Versioned update of incident facts |
| POST | `/v1/incidents/{id}/cancel` | Audited cancellation |
| POST | `/v1/incidents/{id}/allocate` | Request deterministic allocation |
| POST | `/v1/incidents/{id}/reoptimize` | Produce a bounded, anti-thrashing reassignment recommendation |
| GET | `/v1/incidents/{id}` | Read incident and assignments |
| POST | `/v1/resources/telemetry` | Apply source-sequenced resource telemetry |
| POST | `/v1/facilities/capacity` | Apply source-sequenced facility capacity |
| POST | `/v1/environment` | Apply a versioned closure/hazard update |
| POST | `/v1/dispatch/acknowledgements` | Apply responder state with fencing epochs |
| GET | `/v1/decisions/{id}` | Retrieve complete decision evidence |
| POST | `/v1/overrides` | Append an authorized operator override |
| POST | `/v1/warnings` | Authorize a public warning |
| POST | `/v1/outbox/flush` | Local development outbox trigger |
| GET | `/health/live` | Process liveness |
| GET | `/health/ready` | Database and audit readiness |
| GET | `/metrics` | Prometheus text metrics |

## Acknowledgement semantics

`ACCEPTED` means the regional operational quorum committed the incident. `DUPLICATE` returns the original incident for the authority/idempotency pair. `RECEIVED_DEGRADED` means an encrypted edge log retained the incident but no safe exclusive reservation is implied.

Provider `ACCEPTED`, device `DELIVERED`, and human responder `ACKNOWLEDGED` are different notification states and must not be merged.
