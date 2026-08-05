import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Kafka } from "kafkajs";
import { createClient } from "redis";
import { Etcd3 } from "etcd3";

const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:8181";
const token = required("EMERGENCY_API_TOKEN");
const regionId = process.env.REGION_ID ?? "region-a";
const checks: Array<{ check: string; status: "PASS"; evidence: string }> = [];
const createdAt = new Date().toISOString();

const postgres = new Pool({ connectionString: required("POSTGRES_URL"), max: 1, connectionTimeoutMillis: 3_000 });
const kafka = new Kafka({ clientId: `aegis-smoke-${randomUUID()}`, brokers: required("KAFKA_BROKERS").split(",") });
const kafkaAdmin = kafka.admin();
const redis = createClient({ url: required("REDIS_URL") });
const etcd = new Etcd3({ hosts: required("ETCD_ENDPOINTS").split(","), dialTimeout: 3_000 });

try {
  const health = await request("/health/ready", false);
  assert(health.status === "READY" && health.auditIntegrity === true, "Regional readiness or audit integrity failed");
  pass("Regional API", "ready; immutable audit chain valid");

  const topology = await request("/v1/platform/topology");
  const unavailable = topology.integrations.filter((item: { state: string }) => item.state !== "UP");
  assert(topology.mode === "PRODUCTION_DEMO" && unavailable.length === 0,
    `Production integrations unavailable: ${unavailable.map((item: { name: string }) => item.name).join(", ")}`);
  pass("Dependency topology", "PostgreSQL, Kafka, Redis, and etcd report UP");
  assert(topology.optimizer?.state === "UP", `Python optimizer is ${topology.optimizer?.state ?? "missing"}`);
  pass("Python optimization service", `UP; circuit ${topology.optimizer.circuit}`);

  const capability = `SMOKE-${randomUUID().slice(0, 8)}`;
  const resourceId = `smoke-ambulance-${randomUUID().slice(0, 8)}`;
  await request("/v1/resources/telemetry", true, {
    method: "POST",
    body: {
      resourceId, metadata: metadata("resource"), location: { latitude: 22.48, longitude: 91.79, regionId },
      resourceType: "AMBULANCE", capabilities: [capability], capacity: 1, status: "AVAILABLE",
      healthy: true, maintenance: false, sourceSequence: 1, jurisdiction: regionId,
      crewAvailable: true, transportMode: "GROUND",
    },
  });
  const incident = await request("/v1/incidents", true, {
    method: "POST",
    body: {
      metadata: metadata("incident"), location: { latitude: 22.47, longitude: 91.78, regionId },
      severity: 10, affectedPeople: 1, timeToHarmMinutes: 3, requiredCapabilities: [capability],
      requiredCapacity: 1, hazards: [], confidence: 0.99,
      responseDeadline: new Date(Date.now() + 20 * 60_000).toISOString(), autoAllocate: true,
    },
  });
  assert(incident.incident.priority === "P0", "Critical incident was not classified P0");
  assert(incident.allocation.assignments.length === 1, "Exclusive resource was not assigned exactly once");
  pass("Critical decision path", `${incident.incident.incidentId}; one fenced assignment`);
  assert(incident.allocation.decision.mode === "EXACT_OPTIMIZED",
    `Expected exact Python decision, received ${incident.allocation.decision.mode}`);
  assert(incident.allocation.decision.optimizerEvidence?.algorithm === "EXACT_BOUNDED_DP",
    "Exact optimizer evidence is missing from the decision");
  pass("Exact bounded optimization",
    `${incident.allocation.decision.optimizerEvidence.algorithm}; ${incident.allocation.decision.optimizerEvidence.durationMs} ms`);

  const flush = await request("/v1/outbox/flush", true, { method: "POST" });
  assert(flush.failed === 0, `${flush.failed} outbox events failed to publish`);

  const databaseEvidence = await postgres.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM integration_events WHERE received_at >= $1", [createdAt],
  );
  assert(Number(databaseEvidence.rows[0]?.count ?? 0) > 0, "PostgreSQL received no replayable integration events");
  pass("PostgreSQL replay sink", `${databaseEvidence.rows[0]!.count} event(s) durably recorded`);

  await kafkaAdmin.connect();
  const topics = ["emergency.critical.v1", "emergency.operational.v1"];
  const offsets = await Promise.all(topics.map((topic) => kafkaAdmin.fetchTopicOffsets(topic)));
  const kafkaRecords = offsets.flat().reduce((sum, partition) => sum + Number(partition.high), 0);
  assert(kafkaRecords > 0, "Kafka topics contain no published event records");
  pass("Kafka replicated backbone", `${kafkaRecords} visible high-watermark record(s)`);

  await redis.connect();
  const cacheKeys = await redis.keys(`emergency:${regionId}:latest:*`);
  assert(cacheKeys.length > 0, "Redis contains no disposable latest-event projections");
  pass("Redis disposable projection", `${cacheKeys.length} latest-event key(s)`);

  const ownership = await etcd.getAll().prefix(`/emergency/regions/${regionId}/runtime/`).strings();
  assert(Object.keys(ownership).length > 0, "etcd contains no regional ownership registration");
  pass("etcd ownership directory", `${Object.keys(ownership).length} active runtime registration(s)`);

  const finalTopology = await request("/v1/platform/topology");
  assert(finalTopology.retainedOutboxEvents === 0, `${finalTopology.retainedOutboxEvents} events remain in the outbox`);
  pass("Transactional outbox", "zero unpublished events after evidence flush");

  process.stdout.write(`${JSON.stringify({ result: "PASS", checks: checks.length, incidentId: incident.incident.incidentId,
    assignmentId: incident.allocation.assignments[0].assignmentId, evidence: checks }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ result: "FAIL", checks, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([postgres.end(), kafkaAdmin.disconnect(), redis.isOpen ? redis.quit() : Promise.resolve(), Promise.resolve(etcd.close())]);
}

function metadata(kind: string): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  return {
    eventId: randomUUID(), correlationId: randomUUID(), idempotencyKey: `${kind}-${randomUUID()}`,
    schemaVersion: 1, aggregateVersion: 1, policyVersion: "policy-1", mapVersion: "map-1",
    resourceEpoch: 0, shardEpoch: 1, sourceTime: timestamp, effectiveTime: timestamp,
    authority: "regional-eoc", traceId: randomUUID(),
  };
}

async function request(path: string, authenticated = true, options: { method?: string; body?: unknown } = {}): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
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

function pass(check: string, evidence: string): void {
  checks.push({ check, status: "PASS", evidence });
}
