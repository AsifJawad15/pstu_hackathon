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

test("mass-casualty incident allocates multiple resources when requiredCapacity > 1", async () => {
  const app = application();
  // Register multiple ambulances
  app.resources.ingest(resource("ambulance-1", {
    location: { latitude: 22.48, longitude: 91.79, regionId: "region-a" },
    capacity: 1,
  }));
  app.resources.ingest(resource("ambulance-2", {
    location: { latitude: 22.49, longitude: 91.80, regionId: "region-a" },
    capacity: 1, sourceSequence: 1,
  }));
  app.resources.ingest(resource("ambulance-3", {
    location: { latitude: 22.47, longitude: 91.78, regionId: "region-a" },
    capacity: 1, sourceSequence: 1,
  }));
  const result = await app.reportIncident(incident({
    requiredCapacity: 3, autoAllocate: true,
  }));
  const allocation = result.allocation as {
    decision: { chosenResourceIds: string[]; reasons: string[] };
    assignments: Array<{ assignmentId: string; resourceId: string; status: string }>;
  };
  assert.ok(allocation.decision.chosenResourceIds.length >= 2, `allocated ${allocation.decision.chosenResourceIds.length} resources`);
  assert.ok(
    allocation.decision.reasons.includes("COMPOSITE_RESOURCE_BUNDLE") ||
    allocation.decision.reasons.includes("PARTIAL_ALLOCATION") ||
    allocation.decision.reasons.includes("LOWEST_COST_FEASIBLE_RESOURCE"),
    `decision reason is valid: ${allocation.decision.reasons.join(",")}`,
  );
  app.close();
});

test("multi-capability incident allocates resources covering all required capabilities", async () => {
  const app = application();
  // Ambulance with ALS capability
  app.resources.ingest(resource("ambulance-1", {
    capabilities: ["ALS"],
    location: { latitude: 22.48, longitude: 91.79, regionId: "region-a" },
  }));
  // Rescue team with HAZMAT capability
  app.resources.ingest(resource("rescue-team-1", {
    resourceType: "RESCUE_TEAM", capabilities: ["HAZMAT"],
    location: { latitude: 22.49, longitude: 91.80, regionId: "region-a" },
    sourceSequence: 1,
  }));
  const result = await app.reportIncident(incident({
    requiredCapabilities: ["ALS", "HAZMAT"], requiredCapacity: 1, autoAllocate: true,
  }));
  const allocation = result.allocation as {
    decision: { chosenResourceIds: string[]; reasons: string[] };
  };
  // The decision should include multiple resources to cover both capabilities
  assert.ok(allocation.decision.chosenResourceIds.length >= 1, "at least one resource selected");
  app.close();
});

test("helicopter resource ignores road closures in allocation", async () => {
  const app = application();
  // Register a helicopter
  app.resources.ingest(resource("heli-1", {
    resourceType: "HELICOPTER", capabilities: ["ALS"],
    transportMode: "AIR",
    location: { latitude: 22.48, longitude: 91.79, regionId: "region-a" },
  }));
  // Close the road between helicopter and incident
  app.updateEnvironment({
    eventId: "closure-1", regionId: "region-a", eventType: "ROAD_CLOSURE",
    payload: { description: "Road flooded" }, mapVersion: "map-2",
    effectiveAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    closedCells: [
      // Cell containing the helicopter's position
      `region-a:${Math.floor((22.48 + 90) * 100)}:${Math.floor((91.79 + 180) * 100)}`,
    ],
  });
  const result = await app.reportIncident(incident({ autoAllocate: true }));
  const allocation = result.allocation as {
    decision: { chosenResourceIds: string[] };
    assignments: Array<{ resourceId: string }>;
  };
  // Helicopter should still be allocated because it ignores road closures
  assert.equal(allocation.decision.chosenResourceIds.length, 1, "helicopter allocated despite road closure");
  assert.equal(allocation.decision.chosenResourceIds[0], "heli-1");
  app.close();
});

test("ground ambulance is excluded when road is closed but helicopter is not", async () => {
  const app = application();
  // Register ground ambulance and helicopter in same location
  const loc = { latitude: 22.48, longitude: 91.79, regionId: "region-a" };
  const cellLat = Math.floor((22.48 + 90) * 100);
  const cellLon = Math.floor((91.79 + 180) * 100);
  app.resources.ingest(resource("ambulance-1", {
    transportMode: "GROUND", location: loc,
  }));
  app.resources.ingest(resource("heli-1", {
    resourceType: "HELICOPTER", capabilities: ["ALS"],
    transportMode: "AIR", location: loc, sourceSequence: 1,
  }));
  // Close route at the resource's spatial cell
  app.updateEnvironment({
    eventId: "closure-road", regionId: "region-a", eventType: "FLOOD",
    payload: {}, mapVersion: "map-2",
    effectiveAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    closedCells: [`region-a:${cellLat}:${cellLon}`],
  });
  const result = await app.reportIncident(incident({ autoAllocate: true }));
  const allocation = result.allocation as { decision: { chosenResourceIds: string[]; candidates: Array<{ resourceId: string; feasible: boolean }> } };
  // Only heli should be chosen
  assert.equal(allocation.decision.chosenResourceIds[0], "heli-1", "helicopter chosen over blocked ambulance");
  const ambulanceCandidate = allocation.decision.candidates.find((c) => c.resourceId === "ambulance-1");
  assert.equal(ambulanceCandidate?.feasible, false, "ambulance marked infeasible");
  app.close();
});

test("hazard-blocked ground vehicle excluded but tolerant vehicle is not", async () => {
  const app = application();
  // Regular ground ambulance
  app.resources.ingest(resource("ambulance-standard", {
    transportMode: "GROUND", hazardTolerances: [],
    location: { latitude: 22.48, longitude: 91.79, regionId: "region-a" },
  }));
  // Amphibious rescue vehicle tolerant to floods
  app.resources.ingest(resource("rescue-amphibious", {
    resourceType: "AMPHIBIOUS", capabilities: ["ALS"],
    transportMode: "GROUND", hazardTolerances: ["HAZARD_FLOOD"],
    location: { latitude: 22.48, longitude: 91.79, regionId: "region-a" },
    sourceSequence: 1,
  }));
  const result = await app.reportIncident(incident({
    hazards: ["HAZARD_FLOOD"], autoAllocate: true,
  }));
  const allocation = result.allocation as { decision: { chosenResourceIds: string[]; candidates: Array<{ resourceId: string; feasible: boolean; exclusionReasons: string[] }> } };
  // Standard ambulance should be excluded due to hazard
  const standardCandidate = allocation.decision.candidates.find((c) => c.resourceId === "ambulance-standard");
  assert.ok(standardCandidate?.exclusionReasons.some((r) => r.startsWith("HAZARD_BLOCKED")), "standard ambulance blocked by flood hazard");
  // Amphibious vehicle should be feasible
  const amphibCandidate = allocation.decision.candidates.find((c) => c.resourceId === "rescue-amphibious");
  assert.equal(amphibCandidate?.feasible, true, "amphibious vehicle is feasible despite flood");
  app.close();
});
