import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const cases = JSON.parse(await readFile(new URL("./cases.json", import.meta.url), "utf8"));
const host = process.env.HOST === "0.0.0.0" ? "127.0.0.1" : process.env.HOST || "127.0.0.1";
const baseUrl = process.env.EVALUATOR_BASE_URL || `http://${host}:${process.env.PORT || "8181"}`;
const token = process.env.EVALUATOR_API_TOKEN || process.env.EMERGENCY_API_TOKEN;
if (!token) throw new Error("Set EVALUATOR_API_TOKEN or EMERGENCY_API_TOKEN");

const results = [];
const suffix = randomUUID().slice(0, 8);
let winningAssignment;
let concurrentIncidentIds = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function metadata(kind, idempotencyKey = `${kind}-${randomUUID()}`) {
  const now = new Date().toISOString();
  return {
    eventId: randomUUID(), correlationId: randomUUID(), idempotencyKey,
    schemaVersion: 1, aggregateVersion: 1, policyVersion: "policy-1", mapVersion: "map-1",
    resourceEpoch: 0, shardEpoch: 1, sourceTime: now, effectiveTime: now,
    authority: "independent-evaluator", traceId: randomUUID(),
  };
}

function resource(resourceId, capability, sourceSequence = 1) {
  return {
    resourceId, metadata: metadata("resource"),
    location: { latitude: cases.latitude, longitude: cases.longitude, regionId: cases.regionId },
    resourceType: "AMBULANCE", capabilities: [capability], capacity: 1, status: "AVAILABLE",
    healthy: true, maintenance: false, sourceSequence, jurisdiction: cases.regionId, crewAvailable: true,
  };
}

function incident(capability, overrides = {}) {
  return {
    metadata: metadata("incident"),
    location: { latitude: cases.latitude, longitude: cases.longitude, regionId: cases.regionId },
    severity: 9, affectedPeople: 1, timeToHarmMinutes: 5, requiredCapabilities: [capability],
    requiredCapacity: 1, hazards: [], confidence: 0.95,
    responseDeadline: new Date(Date.now() + 30 * 60_000).toISOString(), autoAllocate: false,
    ...overrides,
  };
}

async function call(path, { method = "GET", body, authenticated = true, rawBody = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cases.requestTimeoutMs);
  const headers = {};
  if (authenticated) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers, signal: controller.signal,
      ...(body !== undefined ? { body: rawBody ? body : JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    return { status: response.status, data, durationMs: performance.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

async function scenario(name, run) {
  const started = performance.now();
  try {
    const evidence = await run();
    results.push({ name, passed: true, durationMs: round(performance.now() - started), evidence });
  } catch (error) {
    results.push({ name, passed: false, durationMs: round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error) });
  }
}

await scenario("readiness and audit integrity", async () => {
  const response = await call("/health/ready", { authenticated: false });
  check(response.status === 200, `expected 200, received ${response.status}`);
  check(response.data?.auditIntegrity === true, "audit chain is not healthy");
  return response.data;
});

await scenario("protected API rejects missing bearer token", async () => {
  const response = await call("/v1/incidents", { method: "POST", body: {}, authenticated: false });
  check(response.status === 401, `expected 401, received ${response.status}`);
  return { status: response.status, code: response.data?.error?.code };
});

await scenario("bounded validation rejects invalid coordinates", async () => {
  const input = resource(`invalid-${suffix}`, `INVALID-${suffix}`);
  input.location.latitude = 999;
  const response = await call("/v1/resources/telemetry", { method: "POST", body: input });
  check(response.status === 400, `expected 400, received ${response.status}`);
  return { status: response.status, code: response.data?.error?.code };
});

await scenario("oversized payload is rejected", async () => {
  const response = await call("/v1/incidents", { method: "POST", body: JSON.stringify({ padding: "x".repeat(270_000) }), rawBody: true });
  check(response.status === 413, `expected 413, received ${response.status}`);
  return { status: response.status, code: response.data?.error?.code };
});

await scenario("older telemetry cannot overwrite newer state", async () => {
  const resourceId = `ordered-${suffix}`;
  const capability = `ORDERED-${suffix}`;
  const fresh = await call("/v1/resources/telemetry", { method: "POST", body: resource(resourceId, capability, 10) });
  const stale = await call("/v1/resources/telemetry", { method: "POST", body: resource(resourceId, capability, 9) });
  check(fresh.status === 202 && fresh.data?.applied === true, "fresh telemetry was not applied");
  check(stale.status === 202 && stale.data?.applied === false, "stale telemetry was applied");
  check(stale.data?.resource?.sourceSequence === 10, "effective resource state moved backwards");
  return { effectiveSequence: stale.data.resource.sourceSequence };
});

await scenario("incident idempotency returns the original incident", async () => {
  const key = `evaluator-idempotency-${suffix}`;
  const input = incident(`NO-RESOURCE-${suffix}`);
  input.metadata = metadata("incident", key);
  const first = await call("/v1/incidents", { method: "POST", body: input });
  const second = await call("/v1/incidents", { method: "POST", body: { ...input, incidentId: randomUUID() } });
  check(first.status === 202 && first.data?.status === "ACCEPTED", "first incident was not accepted");
  check(second.status === 202 && second.data?.status === "DUPLICATE", "retry was not deduplicated");
  check(first.data.incident.incidentId === second.data.incident.incidentId, "duplicate returned a different incident");
  await cancelIncident(first.data.incident.incidentId, "black-box idempotency cleanup");
  return { incidentId: first.data.incident.incidentId };
});

await scenario("no feasible resource is explicit and explainable", async () => {
  const response = await call("/v1/incidents", { method: "POST", body: incident(`IMPOSSIBLE-${suffix}`, { autoAllocate: true }) });
  check(response.status === 202, `expected 202, received ${response.status}`);
  check(response.data?.allocation?.decision?.mode === "NO_FEASIBLE_RESOURCE", "unsafe or unexplained allocation result");
  check(response.data?.allocation?.assignments?.length === 0, "an infeasible assignment was created");
  await cancelIncident(response.data.incident.incidentId, "black-box infeasible cleanup");
  return { decisionId: response.data.allocation.decision.decisionId, mode: response.data.allocation.decision.mode };
});

await scenario("concurrent claims create exactly one exclusive assignment", async () => {
  const capability = `EXCLUSIVE-${suffix}`;
  const resourceId = `exclusive-${suffix}`;
  const telemetry = await call("/v1/resources/telemetry", { method: "POST", body: resource(resourceId, capability) });
  check(telemetry.status === 202, "exclusive test resource was not accepted");
  const incidentIds = Array.from({ length: cases.concurrentClaims }, () => randomUUID());
  concurrentIncidentIds = incidentIds;
  const responses = await Promise.all(incidentIds.map((incidentId) => call("/v1/incidents", {
    method: "POST", body: incident(capability, { incidentId, autoAllocate: true }),
  })));
  const records = await Promise.all(incidentIds.map((id) => call(`/v1/incidents/${encodeURIComponent(id)}`)));
  const assignments = records.flatMap((record) => record.status === 200 ? record.data.assignments : []);
  check(assignments.length === 1, `expected one assignment, found ${assignments.length}`);
  check(assignments[0].resourceId === resourceId, "unexpected resource won the exclusive claim");
  winningAssignment = assignments[0];
  const decisionId = responses.find((response) => response.data?.allocation?.decision?.decisionId)?.data.allocation.decision.decisionId;
  check(decisionId, "winning decision evidence was not returned");
  const explanation = await call(`/v1/decisions/${encodeURIComponent(decisionId)}`);
  check(explanation.status === 200 && explanation.data?.chosenResourceIds?.includes(resourceId), "decision evidence is missing");
  const responseStatuses = Object.fromEntries([...new Set(responses.map((response) => response.status))]
    .map((status) => [String(status), responses.filter((response) => response.status === status).length]));
  return { claims: cases.concurrentClaims, assignments: assignments.length, resourceId, decisionId, responseStatuses };
});

await scenario("stale fencing epochs cannot acknowledge dispatch", async () => {
  check(winningAssignment, "exclusive-claim scenario did not produce an assignment");
  const response = await call("/v1/dispatch/acknowledgements", { method: "POST", body: {
    assignmentId: winningAssignment.assignmentId, status: "ACCEPTED", highestResourceEpoch: 0,
    highestShardEpoch: 0, actor: "independent-evaluator",
  } });
  check(response.status === 409, `expected 409, received ${response.status}`);
  check(response.data?.error?.code === "STALE_FENCING_EPOCH", `unexpected error ${response.data?.error?.code}`);
  await completeAssignment(winningAssignment);
  const records = await Promise.all(concurrentIncidentIds.map((id) => call(`/v1/incidents/${encodeURIComponent(id)}`)));
  await Promise.all(records.filter((record) => record.data?.assignments?.length === 0).map((record) => call(
    `/v1/incidents/${encodeURIComponent(record.data.incident.incidentId)}/cancel`,
    { method: "POST", body: { expectedVersion: record.data.incident.version,
      actor: "independent-evaluator", reason: "black-box concurrency cleanup" } },
  )));
  return { status: response.status, code: response.data.error.code };
});

await scenario("regional durable-acceptance latency budget", async () => {
  const samples = [];
  const incidentIds = [];
  for (let index = 0; index < cases.acceptanceSamples; index += 1) {
    const response = await call("/v1/incidents", {
      method: "POST", body: incident(`LATENCY-${suffix}`, { autoAllocate: false }),
    });
    check(response.status === 202, `sample ${index + 1} returned ${response.status}`);
    samples.push(response.durationMs);
    incidentIds.push(response.data.incident.incidentId);
  }
  const p99 = percentile(samples, 0.99);
  check(p99 <= cases.acceptanceP99MaxMs, `p99 ${round(p99)} ms exceeds evaluator limit ${cases.acceptanceP99MaxMs} ms`);
  await Promise.all(incidentIds.map((id) => cancelIncident(id, "black-box latency cleanup")));
  return { samples: samples.length, p50Ms: round(percentile(samples, 0.5)), p99Ms: round(p99),
    limitMs: cases.acceptanceP99MaxMs };
});

await scenario("road degradation preserves isolated air allocation", async () => {
  const capability = `AIR-CONTINUITY-${suffix}`;
  const resourceId = `air-continuity-${suffix}`;
  const location = { latitude: cases.latitude, longitude: cases.longitude, regionId: cases.regionId };
  const spatialCell = `${location.regionId}:${Math.floor((location.latitude + 90) * 100)}:${Math.floor((location.longitude + 180) * 100)}`;
  const closure = await call("/v1/environment", { method: "POST", body: {
    eventId: `closure-${randomUUID()}`, regionId: cases.regionId, eventType: "ROAD_CLOSURE",
    payload: { source: "independent-evaluator" }, mapVersion: `map-${randomUUID()}`,
    effectiveAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10_000).toISOString(),
    closedCells: [spatialCell],
  } });
  check(closure.status === 202 && closure.data?.applied === true, "road closure was not applied");
  const airResource = resource(resourceId, capability);
  airResource.resourceType = "HELICOPTER";
  airResource.transportMode = "AIR";
  const telemetry = await call("/v1/resources/telemetry", { method: "POST", body: airResource });
  check(telemetry.status === 202 && telemetry.data?.applied === true, "air resource was not registered");
  const response = await call("/v1/incidents", { method: "POST", body: incident(capability, { autoAllocate: true }) });
  const assignments = response.data?.allocation?.assignments ?? [];
  check(response.status === 202 && assignments.length === 1, `expected one air assignment, found ${assignments.length}`);
  check(assignments[0].resourceId === resourceId, "road degradation selected an unexpected resource");
  const decisionId = response.data.allocation.decision.decisionId;
  const explanation = await call(`/v1/decisions/${encodeURIComponent(decisionId)}`);
  check(explanation.status === 200 && explanation.data?.chosenResourceIds?.includes(resourceId), "air decision evidence is incomplete");
  await completeAssignment(assignments[0]);
  return { closedCell: spatialCell, resourceId, decisionId, assignments: assignments.length };
});

await scenario("background outbox publication reaches quiescence", async () => {
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const topology = await call("/v1/platform/topology");
  check(topology.status === 200, `topology returned ${topology.status}`);
  check(topology.data?.retainedOutboxEvents === 0,
    `${topology.data?.retainedOutboxEvents ?? "unknown"} events remain unpublished`);
  return { retainedOutboxEvents: topology.data.retainedOutboxEvents, lastPublishedAt: topology.data.lastPublishedAt };
});

const report = {
  evaluator: "public-http-black-box", baseUrl, generatedAt: new Date().toISOString(),
  passed: results.every((result) => result.passed), passedCount: results.filter((result) => result.passed).length,
  failedCount: results.filter((result) => !result.passed).length, results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

function round(value) { return Math.round(value * 1_000) / 1_000; }

async function completeAssignment(assignment) {
  for (const status of ["ACCEPTED", "EN_ROUTE", "ARRIVED", "COMPLETED"]) {
    const response = await call("/v1/dispatch/acknowledgements", { method: "POST", body: {
      assignmentId: assignment.assignmentId, status,
      highestResourceEpoch: assignment.resourceEpoch, highestShardEpoch: assignment.shardEpoch,
      actor: "independent-evaluator",
    } });
    check(response.status === 200, `${assignment.assignmentId} could not transition to ${status}`);
  }
}

async function cancelIncident(incidentId, reason) {
  const record = await call(`/v1/incidents/${encodeURIComponent(incidentId)}`);
  check(record.status === 200, `${incidentId} could not be loaded for cleanup`);
  if (["RESOLVED", "CANCELLED"].includes(record.data.incident.status)) return;
  const response = await call(`/v1/incidents/${encodeURIComponent(incidentId)}/cancel`, {
    method: "POST", body: { expectedVersion: record.data.incident.version, actor: "independent-evaluator", reason },
  });
  check(response.status === 200, `${incidentId} could not be cancelled after evaluation`);
}
