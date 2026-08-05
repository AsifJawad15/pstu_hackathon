import { performance } from "node:perf_hooks";
import { DEFAULT_POLICY, resourceExclusionReasons, type PolicyBundle } from "../domain/policy.ts";
import type { CandidateScore, DecisionExplanation, FacilityCandidate, Incident, Resource } from "../domain/types.ts";
import type { RouteProvider } from "../platform/spatial.ts";
import { distanceMeters } from "../platform/spatial.ts";
import type { OperationalDatabase } from "../platform/database.ts";
import { uuidv7 } from "../platform/ids.ts";
import type { BundleOptimizer } from "./pythonOptimizer.ts";

export class DecisionEngine {
  readonly #routing: RouteProvider;
  readonly #policy: PolicyBundle;
  readonly #optimizer: BundleOptimizer | undefined;

  constructor(routing: RouteProvider, policy: PolicyBundle = DEFAULT_POLICY, optimizer?: BundleOptimizer) {
    this.#routing = routing;
    this.#policy = policy;
    this.#optimizer = optimizer;
  }

  async decide(incident: Incident, resources: Resource[], deadlineMs = 100, database?: OperationalDatabase): Promise<DecisionExplanation> {
    const started = performance.now();
    const deadline = started + Math.max(1, deadlineMs);
    const prefiltered = [...resources]
      .sort((a, b) => a.resourceId.localeCompare(b.resourceId))
      .slice(0, this.#policy.maxCandidateCount);
    const dispatchable = prefiltered.filter((resource) => resource.status === "AVAILABLE" && resource.healthy
      && !resource.maintenance && resource.crewAvailable);
    const freeByType = new Map<string, number>();
    const capabilitySupply = new Map<string, number>();
    for (const resource of dispatchable) {
      freeByType.set(resource.resourceType, (freeByType.get(resource.resourceType) ?? 0) + 1);
      for (const capability of new Set(resource.capabilities)) {
        capabilitySupply.set(capability, (capabilitySupply.get(capability) ?? 0) + 1);
      }
    }

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
      const required = new Set(incident.requiredCapabilities);
      const unusedSpecialistCapabilities = resource.capabilities.filter((capability) => !required.has(capability));
      const scarcity = unusedSpecialistCapabilities.reduce((total, capability) => {
        const supply = capabilitySupply.get(capability) ?? 1;
        return total + Math.ceil(12 / Math.max(1, supply));
      }, 0);
      const remainingSameType = Math.max(0, (freeByType.get(resource.resourceType) ?? 1) - 1);
      const coverageLoss = remainingSameType >= 2 ? 0 : (2 - remainingSameType) * 25;
      const components = {
        eta: Math.min(100_000, route.etaSeconds),
        routeRisk: Math.round((1 - route.confidence) * 1_000),
        scarcity,
        coverageLoss,
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
    let chosenResourceIds: string[] = [];
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

    let selection = selectionFacts(chosenResourceIds, prefiltered, requiredCaps, requiredCapacity);
    let optimizerEvidence: DecisionExplanation["optimizerEvidence"];
    let decisionMode: DecisionExplanation["mode"] = selection.fullyFeasible
      ? "DETERMINISTIC" : chosenResourceIds.length === 0 ? "NO_FEASIBLE_RESOURCE" : "DETERMINISTIC";
    if (this.#optimizer?.configured) {
      const remainingForOptimizer = Math.floor(deadline - performance.now());
      const usable = candidates.flatMap((candidate) => {
        const hardExclusions = candidate.exclusionReasons.filter((reason) =>
          !reason.startsWith("MISSING_CAPABILITY:") && reason !== "INSUFFICIENT_CAPACITY");
        const resource = prefiltered.find((entry) => entry.resourceId === candidate.resourceId);
        return hardExclusions.length === 0 && resource ? [{
          resourceId: resource.resourceId,
          cost: Math.max(0, Math.round(candidate.score * 100)),
          capacity: resource.capacity,
          capabilities: resource.capabilities,
        }] : [];
      });
      if (remainingForOptimizer >= 10 && usable.length > 0) {
        const outcome = await this.#optimizer.selectBundle({ incident, candidates: usable, deadlineMs: remainingForOptimizer });
        if (outcome.result?.feasible) {
          const proposed = selectionFacts(outcome.result.selectedResourceIds, prefiltered, requiredCaps, requiredCapacity);
          const allowed = new Set(usable.map((candidate) => candidate.resourceId));
          const authorityAccepted = proposed.valid && proposed.fullyFeasible
            && outcome.result.selectedResourceIds.every((resourceId) => allowed.has(resourceId));
          if (authorityAccepted) {
            chosenResourceIds = [...outcome.result.selectedResourceIds].sort();
            selection = proposed;
            decisionMode = outcome.result.optimal ? "EXACT_OPTIMIZED" : "PYTHON_INCUMBENT";
            optimizerEvidence = {
              service: "aegis-python-optimizer", solverVersion: outcome.result.solverVersion,
              algorithm: outcome.result.algorithm,
              ...(outcome.result.objective === null ? {} : { objective: outcome.result.objective }),
              optimal: outcome.result.optimal, examinedStates: outcome.result.examinedStates,
              durationMs: outcome.result.durationMs,
            };
          } else {
            optimizerEvidence = { service: "aegis-python-optimizer", fallbackReason: "OPTIMIZER_PLAN_REJECTED_BY_AUTHORITY" };
          }
        } else {
          optimizerEvidence = { service: "aegis-python-optimizer",
            fallbackReason: outcome.fallbackReason ?? "OPTIMIZER_RETURNED_NO_FEASIBLE_BUNDLE" };
        }
      } else {
        optimizerEvidence = { service: "aegis-python-optimizer", fallbackReason: "OPTIMIZER_BUDGET_EXHAUSTED" };
      }
    }

    const reasons: string[] = [];
    if (selection.fullyFeasible) {
      reasons.push(decisionMode === "EXACT_OPTIMIZED" ? "EXACT_MINIMUM_COST_BUNDLE"
        : decisionMode === "PYTHON_INCUMBENT" ? "DEADLINE_BOUNDED_FEASIBLE_INCUMBENT"
          : chosenResourceIds.length > 1 ? "COMPOSITE_RESOURCE_BUNDLE" : "LOWEST_COST_FEASIBLE_RESOURCE");
    } else if (chosenResourceIds.length > 0) {
      reasons.push("PARTIAL_ALLOCATION");
      if (!selection.capacitySatisfied) reasons.push("INSUFFICIENT_AGGREGATE_CAPACITY");
      if (!selection.allCapsCovered) reasons.push("MISSING_AGGREGATE_CAPABILITIES");
    } else {
      reasons.push("NO_RESOURCE_SATISFIED_ALL_HARD_CONSTRAINTS");
    }
    if (optimizerEvidence?.fallbackReason) reasons.push("DETERMINISTIC_OPTIMIZER_FALLBACK");


    return {
      decisionId: uuidv7(), incidentId: incident.incidentId,
      mode: decisionMode,
      policyVersion: this.#policy.version, mapVersion: incident.metadata.mapVersion,
      generatedAt: new Date().toISOString(), deadlineMs,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      chosenResourceIds, candidates,
      reasons,
      snapshotVersions: Object.fromEntries(prefiltered.map((resource) => [resource.resourceId, resource.version])),
      ...(optimizerEvidence ? { optimizerEvidence } : {}),
    };
  }
}

function selectionFacts(ids: string[], resources: Resource[], requiredCaps: Set<string>, requiredCapacity: number): {
  valid: boolean;
  aggregateCapacity: number;
  allCapsCovered: boolean;
  capacitySatisfied: boolean;
  fullyFeasible: boolean;
} {
  const selectedIds = new Set(ids);
  const selected = ids.map((id) => resources.find((resource) => resource.resourceId === id));
  const valid = selectedIds.size === ids.length && selected.every(Boolean);
  const aggregateCapacity = selected.reduce((sum, resource) => sum + (resource?.capacity ?? 0), 0);
  const covered = new Set(selected.flatMap((resource) => resource?.capabilities ?? []));
  const allCapsCovered = [...requiredCaps].every((capability) => covered.has(capability));
  const capacitySatisfied = aggregateCapacity >= requiredCapacity;
  return { valid, aggregateCapacity, allCapsCovered, capacitySatisfied,
    fullyFeasible: valid && ids.length > 0 && allCapsCovered && capacitySatisfied };
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
      decisionId: uuidv7(), mode: "BOUNDED_IMPROVEMENT", generatedAt: new Date().toISOString(),
      chosenResourceIds: [best.resourceId], reasons: ["BOUNDED_IMPROVEMENT_EXCEEDED_POLICY_THRESHOLD"],
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    };
  }
}
