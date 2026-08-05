import test from "node:test";
import assert from "node:assert/strict";
import { EmergencyApplication } from "../src/application.ts";
import { loadConfig } from "../src/config.ts";
import { OperationalDatabase } from "../src/platform/database.ts";
import { incident, resource } from "./fixtures.ts";

function application(): EmergencyApplication {
  return new EmergencyApplication(loadConfig({
    REGION_ID: "region-a", DATABASE_PATH: ":memory:", EMERGENCY_API_TOKEN: "test-token",
    COMMAND_SIGNING_KEY: "a-secure-test-command-signing-key-123456",
    AUTO_ALLOCATE: "true",
  }), new OperationalDatabase());
}

test("out-of-order telemetry cannot overwrite newer resource state", () => {
  const app = application();
  const current = app.resources.ingest(resource("ambulance-1", { sourceSequence: 10 }));
  const stale = app.resources.ingest(resource("ambulance-1", { sourceSequence: 9, capacity: 99 }));
  assert.equal(current.applied, true);
  assert.equal(stale.applied, false);
  assert.equal(app.database.getResource("ambulance-1")?.capacity, 1);
  app.close();
});

test("incident intake is idempotent", async () => {
  const app = application();
  const input = incident({ autoAllocate: false });
  const first = await app.reportIncident(input);
  const duplicate = await app.reportIncident({ ...input, incidentId: crypto.randomUUID() });
  assert.equal(first.status, "ACCEPTED");
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal((first.incident as { incidentId: string }).incidentId, (duplicate.incident as { incidentId: string }).incidentId);
  app.close();
});

test("full feasible-first flow reserves, dispatches, acknowledges and completes", async () => {
  const app = application();
  app.resources.ingest(resource("ambulance-1"));
  const result = await app.reportIncident(incident({ autoAllocate: true }));
  const allocation = result.allocation as { assignments: Array<{ assignmentId: string; status: string }>; commands: Array<{ resourceEpoch: number; shardEpoch: number }> };
  assert.equal(allocation.assignments.length, 1);
  assert.equal(allocation.assignments[0]?.status, "DISPATCHED");
  const assignmentId = allocation.assignments[0]!.assignmentId;
  const command = allocation.commands[0]!;
  app.acknowledge({ assignmentId, status: "ACCEPTED", highestResourceEpoch: command.resourceEpoch, highestShardEpoch: command.shardEpoch, actor: "ambulance-1" });
  app.acknowledge({ assignmentId, status: "EN_ROUTE", highestResourceEpoch: command.resourceEpoch, highestShardEpoch: command.shardEpoch, actor: "ambulance-1" });
  app.acknowledge({ assignmentId, status: "ARRIVED", highestResourceEpoch: command.resourceEpoch, highestShardEpoch: command.shardEpoch, actor: "ambulance-1" });
  const completed = app.acknowledge({ assignmentId, status: "COMPLETED", highestResourceEpoch: command.resourceEpoch, highestShardEpoch: command.shardEpoch, actor: "ambulance-1" });
  assert.equal((completed.incident as { status: string }).status, "RESOLVED");
  assert.equal(app.database.getResource("ambulance-1")?.status, "RELEASED");
  assert.equal(app.database.auditIntegrity(), true);
  app.close();
});

test("concurrent incidents cannot double-assign one exclusive resource", async () => {
  const app = application();
  app.resources.ingest(resource("ambulance-1"));
  const first = await app.reportIncident(incident({ autoAllocate: false }));
  const second = await app.reportIncident(incident({ autoAllocate: false }));
  const outcomes = await Promise.allSettled([
    app.allocate((first.incident as { incidentId: string }).incidentId),
    app.allocate((second.incident as { incidentId: string }).incidentId),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const active = [first, second].flatMap((entry) => app.database.assignmentsForIncident((entry.incident as { incidentId: string }).incidentId));
  assert.equal(active.length, 1);
  app.close();
});

test("concurrent auto-allocation preserves every durable incident receipt while fencing one winner", async () => {
  const app = application();
  const capability = `EXCLUSIVE-${crypto.randomUUID()}`;
  app.resources.ingest(resource("exclusive-auto-unit", { capabilities: [capability] }));
  const inputs = Array.from({ length: 8 }, () => incident({
    incidentId: crypto.randomUUID(), requiredCapabilities: [capability], autoAllocate: true,
  }));
  const outcomes = await Promise.all(inputs.map((input) => app.reportIncident(input)));
  assert.ok(outcomes.every((outcome) => outcome.status === "ACCEPTED"));
  const assignments = inputs.flatMap((input) => app.database.assignmentsForIncident(input.incidentId!));
  assert.equal(assignments.length, 1);
  const modes = outcomes.map((outcome) => (outcome.allocation as { decision: { mode: string } }).decision.mode);
  assert.equal(modes.filter((mode) => mode === "RESERVATION_CONTENDED").length, 7);
  app.close();
});

test("startup recovery returns interrupted allocations to the triage queue", async () => {
  const app = application();
  const accepted = await app.reportIncident(incident({ autoAllocate: false }));
  const incidentId = (accepted.incident as { incidentId: string }).incidentId;
  const reported = app.database.getIncident(incidentId)!;
  const triaged = app.database.transitionIncident(incidentId, reported.version, "TRIAGED");
  app.database.transitionIncident(incidentId, triaged.version, "ALLOCATING");
  assert.deepEqual(app.database.recoverInterruptedAllocations(), [incidentId]);
  assert.equal(app.database.getIncident(incidentId)?.status, "TRIAGED");
  assert.equal(app.database.auditIntegrity(), true);
  app.close();
});

test("stale fencing epochs are rejected", async () => {
  const app = application();
  app.resources.ingest(resource("ambulance-1"));
  const result = await app.reportIncident(incident({ autoAllocate: true }));
  const allocation = result.allocation as { assignments: Array<{ assignmentId: string }> };
  assert.throws(() => app.acknowledge({
    assignmentId: allocation.assignments[0]!.assignmentId, status: "ACCEPTED",
    highestResourceEpoch: 0, highestShardEpoch: 0, actor: "attacker",
  }), /stale ownership epoch/);
  app.close();
});

test("re-optimization recommends a better resource without silently redirecting", async () => {
  const app = application();
  app.resources.ingest(resource("ambulance-original", {
    location: { latitude: 22.52, longitude: 91.83, regionId: "region-a" },
  }));
  const result = await app.reportIncident(incident({ autoAllocate: true }));
  app.resources.ingest(resource("ambulance-near", {
    location: { latitude: 22.4701, longitude: 91.7801, regionId: "region-a" },
  }));
  const recommendation = await app.recommendReoptimization((result.incident as { incidentId: string }).incidentId);
  assert.equal(recommendation.materiallyBetter, true);
  assert.equal(recommendation.requiresOperatorApproval, true);
  assert.equal(recommendation.action, "OPERATOR_APPROVAL_REQUIRED");
  const assignment = (result.allocation as { assignments: Array<{ resourceId: string }> }).assignments[0]!;
  assert.equal(assignment.resourceId, "ambulance-original");
  app.close();
});
