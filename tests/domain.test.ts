import test from "node:test";
import assert from "node:assert/strict";
import { calculatePriority, resourceExclusionReasons } from "../src/domain/policy.ts";
import { assertAssignmentTransition, assertIncidentTransition, assertResourceTransition } from "../src/domain/stateMachines.ts";
import { incident, resource } from "./fixtures.ts";

test("policy evaluation is deterministic and hard P0 override applies", () => {
  const input = incident();
  assert.deepEqual(calculatePriority(input), calculatePriority(input));
  assert.equal(calculatePriority(input).priority, "P0");
});

test("invalid terminal and unsafe transitions are rejected", () => {
  assert.throws(() => assertIncidentTransition("RESOLVED", "ACTIVE"), /cannot transition/);
  assert.throws(() => assertResourceTransition("OUT_OF_SERVICE", "DISPATCHED"), /cannot transition/);
  assert.throws(() => assertAssignmentTransition("COMPLETED", "EN_ROUTE"), /cannot transition/);
  assert.doesNotThrow(() => assertResourceTransition("AVAILABLE", "HELD"));
});

test("hard feasibility reports stable exclusion reasons", () => {
  const input = incident({ requiredCapabilities: ["ALS", "HAZMAT"], requiredCapacity: 2 });
  const raw = resource("ambulance-1", { capabilities: ["ALS"], capacity: 1, maintenance: true });
  const hydrated = {
    ...raw, version: 1, epoch: 0, virtualShard: 1, updatedAt: new Date().toISOString(), spatialCell: "region-a:1:1",
  };
  assert.deepEqual(resourceExclusionReasons(input, hydrated), [
    "RESOURCE_IN_MAINTENANCE", "MISSING_CAPABILITY:HAZMAT", "INSUFFICIENT_CAPACITY",
  ]);
});

