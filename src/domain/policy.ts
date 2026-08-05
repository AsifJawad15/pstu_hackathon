import { invariant } from "./errors.ts";
import type { IncidentInput, Priority, Resource, TransportMode } from "./types.ts";

/** Hazards that block specific transport modes unless the resource explicitly declares tolerance. */
export const HAZARD_VEHICLE_MATRIX: Readonly<Record<string, ReadonlySet<TransportMode>>> = Object.freeze({
  HAZARD_FLOOD:            new Set<TransportMode>(["GROUND"]),
  HAZARD_ROAD_COLLAPSE:    new Set<TransportMode>(["GROUND"]),
  HAZARD_BLIZZARD:         new Set<TransportMode>(["AIR"]),
  HAZARD_AIR_SPACE_CLOSED: new Set<TransportMode>(["AIR"]),
  HAZARD_HIGH_WIND:        new Set<TransportMode>(["AIR", "WATER"]),
  HAZARD_TSUNAMI:          new Set<TransportMode>(["GROUND", "WATER"]),
  HAZARD_BIOHAZARD:        new Set<TransportMode>(["GROUND", "AIR", "WATER"]),
});

export type PolicyBundle = {
  version: string;
  weights: {
    severity: number;
    timeToHarm: number;
    affectedPeople: number;
    vulnerability: number;
    environmentalEscalation: number;
    confidence: number;
  };
  thresholds: { p0: number; p1: number; p2: number };
  maxCandidateCount: number;
  resourceFreshnessSeconds: number;
  reassignmentMinimumImprovement: number;
  commitmentHorizonSeconds: number;
  facilityDiversionMaxExtraSeconds: number;
  facilityCapabilities: string[];
};

export const DEFAULT_POLICY: Readonly<PolicyBundle> = Object.freeze({
  version: "policy-1",
  weights: {
    severity: 28,
    timeToHarm: 24,
    affectedPeople: 13,
    vulnerability: 12,
    environmentalEscalation: 13,
    confidence: 10,
  },
  thresholds: { p0: 80, p1: 60, p2: 35 },
  maxCandidateCount: 32,
  resourceFreshnessSeconds: 120,
  reassignmentMinimumImprovement: 0.15,
  commitmentHorizonSeconds: 180,
  facilityDiversionMaxExtraSeconds: 600,
  facilityCapabilities: ["HOSPITAL_CARE", "TRAUMA", "BURN", "ICU", "SURGICAL"],
});

export function validateIncident(input: IncidentInput, now = Date.now()): void {
  invariant(input.metadata.schemaVersion === 1, "UNSUPPORTED_SCHEMA", "Only schema version 1 is supported", 422);
  invariant(input.metadata.idempotencyKey.length >= 8 && input.metadata.idempotencyKey.length <= 128,
    "INVALID_IDEMPOTENCY_KEY", "Idempotency key must contain 8 to 128 characters");
  invariant(input.metadata.authority.length > 0 && input.metadata.authority.length <= 100,
    "INVALID_AUTHORITY", "Authority is required");
  invariant(Number.isFinite(input.location.latitude) && input.location.latitude >= -90 && input.location.latitude <= 90,
    "INVALID_LOCATION", "Latitude is outside its valid range");
  invariant(Number.isFinite(input.location.longitude) && input.location.longitude >= -180 && input.location.longitude <= 180,
    "INVALID_LOCATION", "Longitude is outside its valid range");
  invariant(input.location.regionId.length > 0, "INVALID_REGION", "Region is required");
  invariant(Number.isInteger(input.severity) && input.severity >= 0 && input.severity <= 10,
    "INVALID_SEVERITY", "Severity must be an integer between 0 and 10");
  invariant(Number.isInteger(input.affectedPeople) && input.affectedPeople >= 0 && input.affectedPeople <= 10_000_000,
    "INVALID_AFFECTED_PEOPLE", "Affected people is outside the supported range");
  invariant(input.timeToHarmMinutes >= 0 && input.timeToHarmMinutes <= 100_000,
    "INVALID_TIME_TO_HARM", "Time to harm is outside the supported range");
  invariant(input.requiredCapabilities.length > 0 && input.requiredCapabilities.length <= 32,
    "INVALID_REQUIREMENTS", "One to 32 resource capabilities are required");
  invariant(input.requiredCapabilities.every((value) => value.length > 0 && value.length <= 64),
    "INVALID_REQUIREMENTS", "Capability names must contain 1 to 64 characters");
  invariant(Number.isInteger(input.requiredCapacity ?? 1) && (input.requiredCapacity ?? 1) >= 1 && (input.requiredCapacity ?? 1) <= 10_000,
    "INVALID_REQUIRED_CAPACITY", "Required capacity must be an integer from 1 to 10000");
  invariant(input.hazards.length <= 32, "INVALID_HAZARDS", "At most 32 hazards are allowed");
  invariant(input.confidence >= 0 && input.confidence <= 1, "INVALID_CONFIDENCE", "Confidence must be between 0 and 1");
  const sourceTime = Date.parse(input.metadata.sourceTime);
  const effectiveTime = Date.parse(input.metadata.effectiveTime);
  const deadline = Date.parse(input.responseDeadline);
  invariant(Number.isFinite(sourceTime) && Math.abs(now - sourceTime) <= 86_400_000,
    "INVALID_SOURCE_TIME", "Source time is invalid or outside the accepted window");
  invariant(Number.isFinite(effectiveTime) && effectiveTime <= now + 300_000,
    "INVALID_EFFECTIVE_TIME", "Effective time is invalid or too far in the future");
  invariant(Number.isFinite(deadline) && deadline > now,
    "INVALID_DEADLINE", "Response deadline must be in the future");
  if (input.metadata.expiryTime) {
    invariant(Date.parse(input.metadata.expiryTime) > now, "EXPIRED_EVENT", "Event has expired", 410);
  }
}

export function calculatePriority(input: IncidentInput, policy: PolicyBundle = DEFAULT_POLICY): { score: number; priority: Priority } {
  const severity = input.severity / 10;
  const urgency = 1 / (1 + Math.max(0, input.timeToHarmMinutes) / 10);
  const people = Math.min(1, Math.log1p(input.affectedPeople) / Math.log(10_001));
  const vulnerability = Math.min(1, (input.vulnerableGroups?.length ?? 0) / 3);
  const escalation = Math.min(1, Math.max(0, input.environmentalEscalation ?? 0));
  const confidence = Math.min(1, Math.max(0, input.confidence));
  const score = Math.round((
    policy.weights.severity * severity +
    policy.weights.timeToHarm * urgency +
    policy.weights.affectedPeople * people +
    policy.weights.vulnerability * vulnerability +
    policy.weights.environmentalEscalation * escalation +
    policy.weights.confidence * confidence
  ) * 100) / 100;

  if (input.severity >= 9 && input.timeToHarmMinutes <= 15 && input.confidence >= 0.5) {
    return { score: Math.max(score, policy.thresholds.p0), priority: "P0" };
  }
  if (score >= policy.thresholds.p0) return { score, priority: "P0" };
  if (score >= policy.thresholds.p1) return { score, priority: "P1" };
  if (score >= policy.thresholds.p2) return { score, priority: "P2" };
  return { score, priority: "P3" };
}

export function resourceExclusionReasons(incident: IncidentInput, resource: Resource, now = Date.now(), policy = DEFAULT_POLICY): string[] {
  const reasons: string[] = [];
  if (resource.status !== "AVAILABLE") reasons.push("RESOURCE_NOT_AVAILABLE");
  if (!resource.healthy) reasons.push("RESOURCE_UNHEALTHY");
  if (resource.maintenance) reasons.push("RESOURCE_IN_MAINTENANCE");
  if (!resource.crewAvailable) reasons.push("CREW_UNAVAILABLE");
  if (resource.weatherRestricted) reasons.push("WEATHER_RESTRICTED");
  if (resource.location.regionId !== incident.location.regionId) reasons.push("JURISDICTION_MISMATCH");
  const missing = incident.requiredCapabilities.filter((capability) => !resource.capabilities.includes(capability));
  if (missing.length > 0) reasons.push(`MISSING_CAPABILITY:${missing.sort().join(",")}`);
  if (resource.capacity < Math.max(1, incident.requiredCapacity ?? 1)) reasons.push("INSUFFICIENT_CAPACITY");
  if (now - Date.parse(resource.updatedAt) > policy.resourceFreshnessSeconds * 1_000) reasons.push("STALE_TELEMETRY");
  // Vehicle-hazard matrix: check if any incident hazard blocks this resource's transport mode
  const mode = resource.transportMode ?? "GROUND";
  const tolerances = new Set(resource.hazardTolerances ?? []);
  for (const hazard of incident.hazards) {
    const blockedModes = HAZARD_VEHICLE_MATRIX[hazard];
    if (blockedModes?.has(mode) && !tolerances.has(hazard)) {
      reasons.push(`HAZARD_BLOCKED:${hazard}`);
    }
  }
  return reasons;
}
