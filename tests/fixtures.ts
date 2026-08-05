import { randomUUID } from "node:crypto";
import type { EventMetadata, IncidentInput, ResourceTelemetryInput } from "../src/domain/types.ts";

export function metadata(overrides: Partial<EventMetadata> = {}): EventMetadata {
  const now = new Date().toISOString();
  return {
    eventId: randomUUID(), correlationId: randomUUID(), idempotencyKey: `idem-${randomUUID()}`,
    schemaVersion: 1, aggregateVersion: 1, policyVersion: "policy-1", mapVersion: "map-1",
    resourceEpoch: 0, shardEpoch: 1, sourceTime: now, effectiveTime: now,
    authority: "regional-eoc", traceId: randomUUID(), ...overrides,
  };
}

export function incident(overrides: Partial<IncidentInput> = {}): IncidentInput {
  return {
    metadata: metadata(), location: { latitude: 22.47, longitude: 91.78, regionId: "region-a" },
    severity: 9, affectedPeople: 1, timeToHarmMinutes: 5, requiredCapabilities: ["ALS"],
    requiredCapacity: 1, hazards: [], vulnerableGroups: [], environmentalEscalation: 0.3,
    confidence: 0.95, responseDeadline: new Date(Date.now() + 30 * 60_000).toISOString(), autoAllocate: false,
    ...overrides,
  };
}

export function resource(resourceId: string, overrides: Partial<ResourceTelemetryInput> = {}): ResourceTelemetryInput {
  return {
    resourceId, metadata: metadata({ sourceSequence: 1 }),
    location: { latitude: 22.48, longitude: 91.79, regionId: "region-a" },
    resourceType: "AMBULANCE", capabilities: ["ALS"], capacity: 1, status: "AVAILABLE",
    healthy: true, maintenance: false, sourceSequence: 1, jurisdiction: "region-a", crewAvailable: true,
    ...overrides,
  };
}

