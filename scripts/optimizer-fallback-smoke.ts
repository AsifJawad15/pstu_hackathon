import { randomUUID } from "node:crypto";

const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:8181";
const token = required("EMERGENCY_API_TOKEN");
const regionId = process.env.REGION_ID ?? "region-a";
const capability = `FALLBACK-${randomUUID().slice(0, 8)}`;
const resourceId = `fallback-unit-${randomUUID().slice(0, 8)}`;

try {
  const topology = await request("/v1/platform/topology");
  assert(topology.optimizer?.state === "DOWN", "Stop the optimizer before running this outage test");

  await request("/v1/resources/telemetry", {
    method: "POST",
    body: {
      resourceId, metadata: metadata("fallback-resource"),
      location: { latitude: 22.48, longitude: 91.79, regionId },
      resourceType: "AMBULANCE", capabilities: [capability], capacity: 1,
      status: "AVAILABLE", healthy: true, maintenance: false, sourceSequence: 1,
      jurisdiction: regionId, crewAvailable: true, transportMode: "GROUND",
    },
  });

  const incident = await request("/v1/incidents", {
    method: "POST",
    body: {
      metadata: metadata("fallback-incident"),
      location: { latitude: 22.47, longitude: 91.78, regionId },
      severity: 10, affectedPeople: 1, timeToHarmMinutes: 3,
      requiredCapabilities: [capability], requiredCapacity: 1, hazards: [], confidence: 0.99,
      responseDeadline: new Date(Date.now() + 20 * 60_000).toISOString(), autoAllocate: true,
    },
  });

  const decision = incident.allocation?.decision;
  assert(incident.allocation?.assignments?.length === 1, "Fallback did not create exactly one safe assignment");
  assert(decision?.mode === "DETERMINISTIC", `Expected DETERMINISTIC fallback, received ${decision?.mode}`);
  assert(decision?.optimizerEvidence?.fallbackReason,
    "The decision did not preserve optimizer failure evidence");
  assert(decision?.reasons?.includes("DETERMINISTIC_OPTIMIZER_FALLBACK"),
    "The fallback reason code is missing");

  process.stdout.write(`${JSON.stringify({
    result: "PASS", incidentId: incident.incident.incidentId,
    assignmentId: incident.allocation.assignments[0].assignmentId,
    decisionMode: decision.mode,
    fallbackReason: decision.optimizerEvidence.fallbackReason,
    evidence: "Python unavailable; regional deterministic authority still reserved and dispatched exactly one resource",
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ result: "FAIL", error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
}

function metadata(kind: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    eventId: randomUUID(), correlationId: randomUUID(), idempotencyKey: `${kind}-${randomUUID()}`,
    schemaVersion: 1, aggregateVersion: 1, policyVersion: "policy-1", mapVersion: "map-1",
    resourceEpoch: 0, shardEpoch: 1, sourceTime: now, effectiveTime: now,
    authority: "regional-eoc", traceId: randomUUID(),
  };
}

async function request(path: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json() as any;
  if (!response.ok) throw new Error(`${path}: ${response.status} ${payload?.error?.code ?? "HTTP_ERROR"}`);
  return payload;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
