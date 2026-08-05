# Independent black-box evaluation

This kit does not import application classes, database methods, fixtures, or internal decision code. It tests only the documented HTTP interface and generates fresh identifiers and capabilities for every run.

Run the complete test against a temporary isolated server and database:

```powershell
npm run evaluate:isolated
```

To test an already running local or deployed instance:

```powershell
$env:EVALUATOR_BASE_URL = "http://127.0.0.1:8181"
$env:EVALUATOR_API_TOKEN = "the-instance-token"
npm run evaluate:blackbox
```

A tester may edit [cases.json](./cases.json) to change concurrency, sample count, latency threshold, region, coordinates, or request timeout. The evaluator exits nonzero on failure and prints machine-readable JSON evidence.

Covered externally observable behavior:

- health and audit integrity;
- authentication and input-size boundaries;
- coordinate validation;
- rejection of out-of-order telemetry;
- incident idempotency;
- explicit no-feasible-resource decisions;
- exactly one assignment under simultaneous exclusive claims;
- stale fencing-epoch rejection;
- public decision-explanation retrieval;
- measured durable-acceptance latency.

This is reproducible independent evidence, not certification. A production assessor should additionally bring their own load generator, malformed inputs, network-fault injection, provider simulators, database failover process, restore media, security scanner, and operator scenarios.
