import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const baseUrl = `http://${process.env.HOST === "0.0.0.0" ? "127.0.0.1" : process.env.HOST || "127.0.0.1"}:${process.env.PORT || "8181"}`;
const token = process.env.EMERGENCY_API_TOKEN;
if (!token) throw new Error("EMERGENCY_API_TOKEN is missing from .env");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const now = new Date().toISOString();
const suffix = randomUUID().slice(0, 8);

function metadata(kind: string) {
  return {
    eventId: randomUUID(), correlationId: randomUUID(), idempotencyKey: `${kind}-${randomUUID()}`,
    schemaVersion: 1, aggregateVersion: 1, policyVersion: "policy-1", mapVersion: "map-1",
    resourceEpoch: 0, shardEpoch: 1, sourceTime: now, effectiveTime: now,
    authority: "regional-eoc", traceId: randomUUID(),
  };
}

const resourceId = `ambulance-${suffix}`;
const resourceResponse = await fetch(`${baseUrl}/v1/resources/telemetry`, {
  method: "POST", headers,
  body: JSON.stringify({
    resourceId, metadata: metadata("resource"),
    location: { latitude: 22.48, longitude: 91.79, regionId: "region-a" },
    resourceType: "AMBULANCE", capabilities: ["ALS"], capacity: 1, status: "AVAILABLE",
    healthy: true, maintenance: false, sourceSequence: 1, jurisdiction: "region-a", crewAvailable: true,
  }),
});
if (!resourceResponse.ok) throw new Error(`Resource seed failed: ${await resourceResponse.text()}`);

const incidentResponse = await fetch(`${baseUrl}/v1/incidents`, {
  method: "POST", headers,
  body: JSON.stringify({
    metadata: metadata("incident"),
    location: { latitude: 22.47, longitude: 91.78, regionId: "region-a" },
    severity: 9, affectedPeople: 1, timeToHarmMinutes: 5,
    requiredCapabilities: ["ALS"], requiredCapacity: 1, hazards: [], confidence: 0.95,
    responseDeadline: new Date(Date.now() + 30 * 60_000).toISOString(), autoAllocate: true,
  }),
});
if (!incidentResponse.ok) throw new Error(`Incident seed failed: ${await incidentResponse.text()}`);
const result = await incidentResponse.json() as { incident: { incidentId: string }; allocation?: unknown };
const record = { incidentId: result.incident.incidentId, resourceId, createdAt: new Date().toISOString(), baseUrl };
mkdirSync("data", { recursive: true });
writeFileSync("data/demo-incident.json", JSON.stringify(record, null, 2));
process.stdout.write(`${JSON.stringify(record)}\n`);
