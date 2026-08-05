import { performance } from "node:perf_hooks";
import { DecisionEngine } from "../src/services/decision.ts";
import { ResourceIndex } from "../src/services/resources.ts";
import { LocalRoutingService, spatialCell } from "../src/platform/spatial.ts";
import { calculatePriority } from "../src/domain/policy.ts";
import type { Incident, Resource } from "../src/domain/types.ts";
import { incident as incidentFixture, resource as resourceFixture } from "../tests/fixtures.ts";
import { virtualShard } from "../src/platform/sharding.ts";

const RESOURCE_COUNT = Number(process.env.BENCHMARK_RESOURCES ?? 50_000);
const ITERATIONS = Number(process.env.BENCHMARK_ITERATIONS ?? 500);
const index = new ResourceIndex();

for (let value = 0; value < RESOURCE_COUNT; value += 1) {
  const input = resourceFixture(`resource-${value}`, {
    location: { latitude: 22.47 + (value % 100) / 10_000, longitude: 91.78 + (value % 80) / 10_000, regionId: "region-a" },
    sourceSequence: value + 1,
  });
  const hydrated: Resource = {
    ...input, version: 1, epoch: 0, virtualShard: virtualShard("region-a", input.resourceId),
    updatedAt: new Date().toISOString(), spatialCell: spatialCell(input.location),
  };
  index.update(hydrated);
}

const rawIncident = incidentFixture();
const priority = calculatePriority(rawIncident);
const incident: Incident = {
  ...rawIncident, incidentId: "benchmark-incident", priority: priority.priority, priorityScore: priority.score,
  status: "TRIAGED", version: 1, virtualShard: 1, acceptedAt: new Date().toISOString(),
};
const routing = new LocalRoutingService();
const decisionEngine = new DecisionEngine(routing);
const lookupSamples: number[] = [];
const decisionSamples: number[] = [];

for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
  let started = performance.now();
  const candidates = index.search(incident.location, 32);
  lookupSamples.push(performance.now() - started);
  started = performance.now();
  await decisionEngine.decide(incident, candidates, 100);
  decisionSamples.push(performance.now() - started);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

const result = {
  resourceCount: RESOURCE_COUNT,
  iterations: ITERATIONS,
  candidateLookupMs: { p50: percentile(lookupSamples, 0.5), p99: percentile(lookupSamples, 0.99), targetP99: 20 },
  feasibleDecisionMs: { p50: percentile(decisionSamples, 0.5), p99: percentile(decisionSamples, 0.99), targetP99: 100 },
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.candidateLookupMs.p99 > result.candidateLookupMs.targetP99 || result.feasibleDecisionMs.p99 > result.feasibleDecisionMs.targetP99) {
  process.exitCode = 1;
}
