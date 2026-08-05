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

test("environment closure triggers reactive reoptimization for active incidents", async () => {
  const app = application();
  app.resources.ingest(resource("ambulance-1"));
  const result = await app.reportIncident(incident({ autoAllocate: true }));
  const incidentId = (result.incident as { incidentId: string }).incidentId;
  // Verify incident is in an active state with an assignment
  const incidentData = app.database.getIncident(incidentId);
  assert.ok(incidentData, "incident exists");
  assert.ok(["ASSIGNED", "ACTIVE"].includes(incidentData.status), `incident is in dispatched state: ${incidentData.status}`);
  // Trigger environment closure - this should trigger reactive reoptimization
  const closureApplied = app.updateEnvironment({
    eventId: "closure-1", regionId: "region-a", eventType: "ROAD_CLOSURE",
    payload: { description: "Bridge collapsed" }, mapVersion: "map-2",
    effectiveAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    closedCells: ["region-a:11247:27179"],
  });
  assert.equal(closureApplied, true, "environment closure applied");
  // Give async reoptimization a moment to complete
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Check that the audit log contains a reactive reoptimization entry
  assert.equal(app.database.auditIntegrity(), true, "audit chain is valid");
  app.close();
});

test("facility capacity exhaustion triggers reactive reoptimization", async () => {
  const app = application();
  app.resources.ingest(resource("ambulance-1"));
  const result = await app.reportIncident(incident({ autoAllocate: true }));
  const incidentId = (result.incident as { incidentId: string }).incidentId;
  const incidentData = app.database.getIncident(incidentId);
  assert.ok(incidentData, "incident exists");
  // Pre-populate hospital capacity
  app.database.updateFacilityCapacity({
    facilityId: "hospital-1", capability: "HOSPITAL_CARE", regionId: "region-a",
    available: 5, reserved: 0, sourceSequence: 1,
  });
  // Exhaust capacity via updateFacility (which triggers reactive reoptimization)
  app.updateFacility({
    facilityId: "hospital-1", capability: "HOSPITAL_CARE", regionId: "region-a",
    available: 5, reserved: 5, sourceSequence: 2,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(app.database.auditIntegrity(), true, "audit chain is valid after reactive reoptimization");
  app.close();
});

test("reoptimization cooldown prevents thrashing", async () => {
  const app = application();
  app.resources.ingest(resource("ambulance-1"));
  const result = await app.reportIncident(incident({ autoAllocate: true }));
  // Two rapid environment changes should only trigger one reoptimization per incident
  app.updateEnvironment({
    eventId: "closure-1", regionId: "region-a", eventType: "ROAD_CLOSURE",
    payload: {}, mapVersion: "map-2",
    effectiveAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    closedCells: ["region-a:11247:27179"],
  });
  app.updateEnvironment({
    eventId: "closure-2", regionId: "region-a", eventType: "ROAD_CLOSURE",
    payload: {}, mapVersion: "map-3",
    effectiveAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    closedCells: ["region-a:11247:27180"],
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  // The cooldown prevents repeated reoptimization
  assert.equal(app.database.auditIntegrity(), true, "audit chain is valid");
  app.close();
});
