import { calculatePriority } from "../src/domain/policy.ts";
import type { Incident, Resource } from "../src/domain/types.ts";
import { OperationalDatabase } from "../src/platform/database.ts";
import { spatialCell } from "../src/platform/spatial.ts";
import { virtualShard } from "../src/platform/sharding.ts";
import { incident as incidentFixture, resource as resourceFixture } from "../tests/fixtures.ts";

const CLAIMS = Number(process.env.RESERVATION_CLAIMS ?? 2_000);
const database = new OperationalDatabase();
const resourceInput = resourceFixture("exclusive-ambulance");
const resource: Resource = {
  ...resourceInput, version: 1, epoch: 0, virtualShard: virtualShard("region-a", resourceInput.resourceId),
  updatedAt: new Date().toISOString(), spatialCell: spatialCell(resourceInput.location),
};
database.upsertResource(resource);

const incidentIds: string[] = [];
for (let index = 0; index < CLAIMS; index += 1) {
  const raw = incidentFixture({ incidentId: `stress-incident-${index}`, autoAllocate: false });
  const priority = calculatePriority(raw);
  const incident: Incident = {
    ...raw, incidentId: raw.incidentId!, priority: priority.priority, priorityScore: priority.score,
    status: "REPORTED", version: 1, virtualShard: virtualShard("region-a", raw.incidentId!), acceptedAt: new Date().toISOString(),
  };
  database.acceptIncident(incident);
  database.transitionIncident(incident.incidentId, 1, "TRIAGED");
  database.transitionIncident(incident.incidentId, 2, "ALLOCATING");
  incidentIds.push(incident.incidentId);
}

const outcomes = await Promise.allSettled(incidentIds.map((incidentId) => Promise.resolve().then(() =>
  database.reserveResources(incidentId, [{ resourceId: resource.resourceId, expectedVersion: 1 }], 1),
)));
const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
const conflicts = outcomes.filter((outcome) => outcome.status === "rejected");
const result = { claims: CLAIMS, winners: winners.length, conflicts: conflicts.length };
process.stdout.write(`${JSON.stringify(result)}\n`);
database.close();
if (winners.length !== 1 || conflicts.length !== CLAIMS - 1) process.exitCode = 1;
