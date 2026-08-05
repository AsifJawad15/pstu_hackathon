import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { DEFAULT_POLICY, resourceExclusionReasons, type PolicyBundle } from "../domain/policy.ts";
import type { CandidateScore, DecisionExplanation, FacilityCandidate, Incident, Resource } from "../domain/types.ts";
import type { RouteProvider } from "../platform/spatial.ts";
import { distanceMeters } from "../platform/spatial.ts";
import type { OperationalDatabase } from "../platform/database.ts";

export class DecisionEngine {
  readonly #routing: RouteProvider;
  readonly #policy: PolicyBundle;

  constructor(routing: RouteProvider, policy: PolicyBundle = DEFAULT_POLICY) {
    this.#routing = routing;
    this.#policy = policy;
  }

  async decide(incident: Incident, resources: Resource[], deadlineMs = 100, database?: OperationalDatabase): Promise<DecisionExplanation> {
    const started = performance.now();
    const deadline = started + Math.max(1, deadlineMs);
    const prefiltered = [...resources]
      .sort((a, b) => a.resourceId.localeCompare(b.resourceId))
      .slice(0, this.#policy.maxCandidateCount);

    const candidates = await Promise.all(prefiltered.map(async (resource): Promise<CandidateScore> => {
      const exclusionReasons = resourceExclusionReasons(incident, resource, Date.now(), this.#policy);
      const remaining = Math.max(0, deadline - performance.now());
      const transportMode = resource.transportMode ?? "GROUND";
      const route = remaining > 0
        ? await this.#routing.estimate(resource.location, incident.location, remaining, transportMode)
        : { etaSeconds: Number.POSITIVE_INFINITY, distanceMeters: Number.POSITIVE_INFINITY, confidence: 0,
            source: "GEOMETRIC_FALLBACK" as const };
      if (!Number.isFinite(route.etaSeconds)) exclusionReasons.push("ROUTE_UNAVAILABLE");
      if (Date.now() + route.etaSeconds * 1_000 > Date.parse(incident.responseDeadline)) exclusionReasons.push("MISSES_DEADLINE");
      const scarcity = incident.requiredCapabilities.filter((capability) => resource.capabilities.includes(capability)).length > 1 ? 15 : 2;
      const components = {
        eta: Math.min(100_000, route.etaSeconds),
        routeRisk: Math.round((1 - route.confidence) * 1_000),
        scarcity,
        coverageLoss: resource.capabilities.length > 3 ? 20 : 5,
        handover: 0,
      };

      // Evaluate destination facility if incident requires hospital/facility care
      let destinationFacility: FacilityCandidate | undefined;
      if (database && exclusionReasons.length === 0) {
        const needsFacility = incident.requiredCapabilities.some((cap) =>
          this.#policy.facilityCapabilities.includes(cap));
        if (needsFacility) {
          const facilityCapability = incident.requiredCapabilities.find((cap) =>
            this.#policy.facilityCapabilities.includes(cap)) ?? "HOSPITAL_CARE";
          const facilities = database.getFacilitiesByRegion(incident.location.regionId, facilityCapability);
          for (const facility of facilities) {
            const facilityLoc = database.getFacilityLocation(facility.facilityId);
            if (!facilityLoc) continue;
            const facilityPoint = { latitude: facilityLoc.latitude, longitude: facilityLoc.longitude, regionId: facilityLoc.regionId };
            const dist = distanceMeters(incident.location, facilityPoint);
            const eta = Math.ceil(dist * 1.35 / 11.1); // simple ground ETA estimate
            if (eta <= this.#policy.facilityDiversionMaxExtraSeconds) {
              destinationFacility = {
                facilityId: facility.facilityId, capability: facilityCapability,
                regionId: facility.regionId, available: facility.available,
                reserved: facility.reserved, distanceMeters: dist, etaSeconds: eta,
                score: eta + (facility.reserved / Math.max(1, facility.available)) * 100,
              };
              break; // take best available
            }
          }
          if (!destinationFacility && facilities.length > 0) {
            exclusionReasons.push("NO_REACHABLE_FACILITY");
          }
        }
      }

      return {
        resourceId: resource.resourceId,
        feasible: exclusionReasons.length === 0,
        exclusionReasons: [...new Set(exclusionReasons)].sort(),
        etaSeconds: route.etaSeconds,
        distanceMeters: route.distanceMeters,
        routeConfidence: route.confidence,
        routeSource: route.source,
        score: components.eta + components.routeRisk + components.scarcity + components.coverageLoss,
        components,
        resourceVersion: resource.version,
        resourceEpoch: resource.epoch,
        ...(destinationFacility ? { destinationFacility } : {}),
      };
    }));

    candidates.sort((a, b) => Number(b.feasible) - Number(a.feasible) || a.score - b.score || a.resourceId.localeCompare(b.resourceId));

    // Composite bundling: select multiple resources if requiredCapacity > 1 or multiple capabilities needed
    const requiredCapacity = Math.max(1, incident.requiredCapacity ?? 1);
    const requiredCaps = new Set(incident.requiredCapabilities);
    const needsComposite = requiredCapacity > 1 || requiredCaps.size > 1;
    const chosenResourceIds: string[] = [];
    let aggregateCapacity = 0;
    const coveredCapabilities = new Set<string>();

    for (const candidate of candidates) {
      // In composite mode, allow resources that are only excluded due to MISSING_CAPABILITY
      // or INSUFFICIENT_CAPACITY since the bundle as a whole covers aggregate requirements
      const hardExclusions = candidate.exclusionReasons.filter((r) =>
        !r.startsWith("MISSING_CAPABILITY:") && r !== "INSUFFICIENT_CAPACITY");
      const isUsable = needsComposite ? hardExclusions.length === 0 : candidate.feasible;
      if (!isUsable) continue;
      if (aggregateCapacity >= requiredCapacity && [...requiredCaps].every((c) => coveredCapabilities.has(c))) break;
      chosenResourceIds.push(candidate.resourceId);
      const res = prefiltered.find((r) => r.resourceId === candidate.resourceId);
      if (res) {
        aggregateCapacity += res.capacity;
        res.capabilities.forEach((c) => coveredCapabilities.add(c));
      }
    }

    const allCapsCovered = [...requiredCaps].every((c) => coveredCapabilities.has(c));
    const capacitySatisfied = aggregateCapacity >= requiredCapacity;
    const fullyFeasible = chosenResourceIds.length > 0 && allCapsCovered && capacitySatisfied;

    const reasons: string[] = [];
    if (fullyFeasible) {
      reasons.push(chosenResourceIds.length > 1 ? "COMPOSITE_RESOURCE_BUNDLE" : "LOWEST_COST_FEASIBLE_RESOURCE");
    } else if (chosenResourceIds.length > 0) {
      reasons.push("PARTIAL_ALLOCATION");
      if (!capacitySatisfied) reasons.push("INSUFFICIENT_AGGREGATE_CAPACITY");
      if (!allCapsCovered) reasons.push("MISSING_AGGREGATE_CAPABILITIES");
    } else {
      reasons.push("NO_RESOURCE_SATISFIED_ALL_HARD_CONSTRAINTS");
    }


    return {
      decisionId: randomUUID(), incidentId: incident.incidentId,
      mode: fullyFeasible ? "DETERMINISTIC" : chosenResourceIds.length === 0 ? "NO_FEASIBLE_RESOURCE" : "DETERMINISTIC",
      policyVersion: this.#policy.version, mapVersion: incident.metadata.mapVersion,
      generatedAt: new Date().toISOString(), deadlineMs,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      chosenResourceIds, candidates,
      reasons,
      snapshotVersions: Object.fromEntries(prefiltered.map((resource) => [resource.resourceId, resource.version])),
    };
  }
}

export class BoundedOptimizer {
  improve(current: DecisionExplanation, deadlineMs: number): DecisionExplanation {
    const started = performance.now();
    if (current.chosenResourceIds.length === 0 || deadlineMs <= 0) return current;
    const feasible = current.candidates.filter((candidate) => candidate.feasible).sort((a, b) => a.score - b.score || a.resourceId.localeCompare(b.resourceId));
    const best = feasible[0];
    if (!best || performance.now() - started >= deadlineMs) return current;
    if (current.chosenResourceIds[0] === best.resourceId) return current;
    return {
      ...current,
      decisionId: randomUUID(), mode: "BOUNDED_IMPROVEMENT", generatedAt: new Date().toISOString(),
      chosenResourceIds: [best.resourceId], reasons: ["BOUNDED_IMPROVEMENT_EXCEEDED_POLICY_THRESHOLD"],
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    };
  }
}
