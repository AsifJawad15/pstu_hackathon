# Interface testing guide

For the multi-service PostgreSQL, Kafka, Redis, etcd, Prometheus, and Grafana environment—and for live failure/recovery demonstrations—start with [Production Demonstration Runbook](./production-demo.md). This guide focuses on actions inside the command console.

This guide verifies the demonstrator through its public web interface. It is organized around the objectives and functional expectations in `Hackathon Preli Question Set.pdf`.

## 1. Start the application

Requirements: Node.js 24 or newer and an initialized `.env` file.

```powershell
npm install
npm start
```

Open `http://127.0.0.1:8181`. If `.env` contains a different `PORT`, use that port instead.

To copy the local API token without displaying it in the terminal:

```powershell
$apiToken = (Get-Content .env | Where-Object { $_ -match '^EMERGENCY_API_TOKEN=' }) -replace '^EMERGENCY_API_TOKEN=', ''
$apiToken | Set-Clipboard
```

Do not commit, screenshot, or share a real deployment token.

## 2. Connect the console

1. Paste the token into **API token**.
2. Leave **Region** as `region-a` unless the server uses another region.
3. Select **Connect**.

Expected result:

- The connection message becomes **Secure link established**.
- The left rail displays the active region.
- System status is **System ready**.
- Incident, resource, assignment, facility, and outbox metrics load.

If the console reports `UNAUTHENTICATED`, the browser token does not exactly match `EMERGENCY_API_TOKEN` in `.env`.

## 3. Run the automatic interface validation

Scroll to **Evaluator mode** and select **Run guided validation**. The browser creates fresh, isolated identifiers for every run and uses only documented HTTP endpoints.

Expected result: all five rows become **PASS**.

| Check | What the interface performs | Required result |
|---|---|---|
| Regional readiness | Reads `/health/ready` | Region is ready and audit-chain integrity is true |
| Dynamic resource | Registers a new source-sequenced ALS resource | Telemetry is accepted |
| Feasible allocation | Reports a high-confidence severity-9 incident | Incident becomes P0 and exactly one resource is assigned |
| Explainability | Retrieves the stored decision | Chosen resource, candidates, policy version and reason evidence exist |
| Conflict protection | Sends a stale acknowledgement, then submits eight simultaneous incidents for one exclusive resource | Stale epoch returns `409 STALE_FENCING_EPOCH`; exactly one active assignment exists |

The final result displays the number of checks and total browser-to-server time. This is an acceptance check, not a national production load certification.

## 4. Demonstrate the PDF decision workflow

### Prepare dynamic resources

Select **Prepare baseline**.

The interface registers:

- an ALS ground ambulance;
- a rescue team;
- an air resource tolerant of road-collapse and flood hazards;
- a regional hospital with available capacity.

Expected result: the operation timeline says **Baseline ready**, and **Resources ready** and **Facility headroom** increase.

### Test intelligent prioritization and allocation

Select **Critical medical**.

Expected result:

- The incident receives P0 priority.
- At least one feasible ALS resource is assigned and dispatched.
- The incident inspector shows assignment count, resource epoch, policy version, decision mode and route evidence.
- The timeline shows the measured interface response time.

This tests continuous intake, intelligent priority, feasible resource selection, response-time minimization, fencing and explainability.

### Test composite mass-casualty allocation

Prepare a new baseline if earlier resources are already dispatched, then select **Mass casualty**.

Expected result:

- The incident is P0.
- The decision covers both `ALS` and `RESCUE` requirements.
- Multiple resources may be selected when no single resource covers the complete requirement bundle.
- Candidate exclusions remain visible under **Raw API evidence**.

### Test a road becoming unavailable

Select **Road collapse** and then **Re-optimize**.

Expected result:

- The map/environment event is applied.
- Ground routes through the closed cell become infeasible.
- Air resources remain eligible for road-only failures.
- Re-optimization returns a controlled action such as `KEEP_CURRENT_ASSIGNMENT`, `NO_CHANGE`, or `OPERATOR_APPROVAL_REQUIRED`; it never silently redirects a committed responder.

### Test hospital saturation

Select **Hospital saturation**.

Expected result:

- Available and reserved capacity become equal for the test facility.
- A reactive re-optimization evaluation is triggered for active regional work.
- Future hospital-dependent decisions must use another feasible facility or return an explicit diversion/no-feasible explanation.

### Test vehicle failure

Select **Vehicle failure** after preparing a baseline.

Expected result:

- A ground resource changes to `OUT_OF_SERVICE` with a newer source sequence.
- It leaves the available candidate pool.
- The ready-resource metric decreases.

### Inspect any incident

Select a row under **Recent incidents**, or paste an incident UUID into **Incident inspector** and select **Inspect**.

Verify:

- priority and lifecycle state;
- active assignment count;
- fencing epoch;
- deterministic or no-feasible decision mode;
- policy and map evidence;
- candidate feasibility, exclusions, scores, route source and state versions in the raw evidence.

## 5. PDF requirement-to-interface matrix

| PDF objective | Interface evidence |
|---|---|
| Continuous emergency events | Repeat incident scenarios; recent incident and metric updates appear without a reload |
| Intelligent prioritization | Severity-9, urgent, high-confidence incidents display P0 |
| Appropriate resource allocation | Required capabilities and capacity appear in decision evidence |
| Continuous re-optimization | Road, hospital and vehicle changes plus the re-optimize action |
| Minimize response time | Timeline duration and guided-validation duration |
| Maximize utilization | Ready/total resources, active assignments and facility headroom |
| Prevent conflicts | Simultaneous-claim and stale-fencing checks in evaluator mode |
| Partial-failure continuity | Road and vehicle failure scenarios; architecture evidence explains regional independence and routing fallback |
| Scale efficiently | Regional snapshot and external configurable black-box evaluator; full load proof remains a production gate |
| Architecture and data flow | Six-step bounded decision loop at the top of the interface |
| Monitoring and observability | Readiness, audit integrity, operational metrics, backlog age and operation timeline |
| Database, caching and events | Raw decision versions, fencing evidence, outbox backlog and documentation; PostgreSQL/Kafka production topology remains a blueprint |
| Security | Bearer-protected operations, bounded payloads, immutable audit evidence and stale-command rejection |

## 6. Independent tester mode

The web-interface tests are intentionally supplemented by a black-box evaluator that contains no imports from application code:

```powershell
npm run evaluate:isolated
```

An assessor can change concurrency, region, coordinates, timeouts, sample count and the latency gate in `evaluation/cases.json`, or ignore the supplied tests and call the documented API using Postman, k6, JMeter or their own client.

## 7. Troubleshooting

| Symptom | Resolution |
|---|---|
| System offline | Confirm `npm start` is still running and open the configured host/port |
| Token rejected | Re-copy only the value after `EMERGENCY_API_TOKEN=` and reconnect |
| No feasible resource | Select **Prepare baseline** again; previously dispatched resources are intentionally unavailable |
| Vehicle failure says baseline required | Select **Prepare baseline** first |
| Re-optimize says incident required | Create or inspect an incident first |
| Road scenario affects later tests | Restart with a dedicated temporary database or use `npm run evaluate:isolated` |
| Metrics do not change immediately | Select **Refresh** or wait up to 12 seconds for the bounded background refresh |

## 8. Honest acceptance boundary

The interface proves demonstrator behavior. It does not by itself prove five-nines availability, 50,000 events per second, telecom delivery, three-fault-domain failover, paired-region recovery, HSM custody, backup restoration, security certification or human operational readiness. Those remain the production gates described in `plan.md` and `docs/stage-status.md`.
