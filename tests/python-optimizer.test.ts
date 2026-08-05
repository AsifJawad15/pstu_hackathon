import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EmergencyApplication } from "../src/application.ts";
import { loadConfig } from "../src/config.ts";
import { DEFAULT_POLICY } from "../src/domain/policy.ts";
import { OperationalDatabase } from "../src/platform/database.ts";
import { DecisionEngine } from "../src/services/decision.ts";
import type { BundleOptimizer, BundleOptimizationOutcome } from "../src/services/pythonOptimizer.ts";
import { PythonOptimizerClient } from "../src/services/pythonOptimizer.ts";
import { incident, resource } from "./fixtures.ts";

class FakeOptimizer implements BundleOptimizer {
  readonly configured = true;
  readonly #outcome: BundleOptimizationOutcome;
  constructor(outcome: BundleOptimizationOutcome) { this.#outcome = outcome; }
  async selectBundle(): Promise<BundleOptimizationOutcome> { return this.#outcome; }
}

function application(): EmergencyApplication {
  return new EmergencyApplication(loadConfig({
    REGION_ID: "region-a", DATABASE_PATH: ":memory:", EMERGENCY_API_TOKEN: "test-token",
    COMMAND_SIGNING_KEY: "a-secure-test-command-signing-key-123456",
  }), new OperationalDatabase());
}

test("Python exact bundle is accepted only after authoritative capability and capacity validation", async () => {
  const app = application();
  app.resources.ingest(resource("all-rounder", { capabilities: ["ALS", "RESCUE"], capacity: 2 }));
  app.resources.ingest(resource("als", { capabilities: ["ALS"], capacity: 1 }));
  app.resources.ingest(resource("rescue", { resourceType: "RESCUE_TEAM", capabilities: ["RESCUE"], capacity: 1 }));
  const accepted = app.incidents.report(incident({ requiredCapabilities: ["ALS", "RESCUE"], requiredCapacity: 2 }));
  const optimizer = new FakeOptimizer({ result: {
    schemaVersion: 1, solverVersion: "test-exact", algorithm: "EXACT_BOUNDED_DP",
    optimal: true, feasible: true, selectedResourceIds: ["als", "rescue"], objective: 100,
    coveredCapacity: 2, examinedStates: 8, durationMs: 0.2, deadlineMs: 40,
  } });
  const engine = new DecisionEngine(app.routing, DEFAULT_POLICY, optimizer);
  const decision = await engine.decide(accepted.incident, app.database.listResources("region-a"), 100, app.database);
  assert.equal(decision.mode, "EXACT_OPTIMIZED");
  assert.deepEqual(decision.chosenResourceIds, ["als", "rescue"]);
  assert.equal(decision.optimizerEvidence?.algorithm, "EXACT_BOUNDED_DP");
  assert.ok(decision.reasons.includes("EXACT_MINIMUM_COST_BUNDLE"));
  app.close();
});

test("an optimizer plan containing a hard-excluded resource is rejected", async () => {
  const app = application();
  app.resources.ingest(resource("safe-unit", { capabilities: ["ALS"], capacity: 1 }));
  app.resources.ingest(resource("maintenance-unit", { capabilities: ["ALS"], capacity: 1, maintenance: true }));
  const accepted = app.incidents.report(incident());
  const optimizer = new FakeOptimizer({ result: {
    schemaVersion: 1, solverVersion: "malicious-test", algorithm: "EXACT_BOUNDED_DP",
    optimal: true, feasible: true, selectedResourceIds: ["maintenance-unit"], objective: 1,
    coveredCapacity: 1, examinedStates: 1, durationMs: 0.1, deadlineMs: 40,
  } });
  const engine = new DecisionEngine(app.routing, DEFAULT_POLICY, optimizer);
  const decision = await engine.decide(accepted.incident, app.database.listResources("region-a"), 100, app.database);
  assert.deepEqual(decision.chosenResourceIds, ["safe-unit"]);
  assert.equal(decision.mode, "DETERMINISTIC");
  assert.equal(decision.optimizerEvidence?.fallbackReason, "OPTIMIZER_PLAN_REJECTED_BY_AUTHORITY");
  app.close();
});

test("Python optimizer client opens its circuit after repeated failures", async () => {
  const client = new PythonOptimizerClient({
    url: "http://127.0.0.1:1", sharedSecret: "test-secret", deadlineMs: 5,
  });
  const app = application();
  const accepted = app.incidents.report(incident());
  const input = { incident: accepted.incident, deadlineMs: 5, candidates: [
    { resourceId: "unit", cost: 1, capacity: 1, capabilities: ["ALS"] },
  ] };
  await client.selectBundle(input);
  await client.selectBundle(input);
  await client.selectBundle(input);
  const fourth = await client.selectBundle(input);
  assert.equal(client.snapshot().circuit, "OPEN");
  assert.equal(fourth.fallbackReason, "OPTIMIZER_CIRCUIT_OPEN");
  app.close();
});

test("optimizer overload falls back without opening the dependency circuit", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "OPTIMIZER_OVERLOADED" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new PythonOptimizerClient({
    url: `http://127.0.0.1:${address.port}`, sharedSecret: "test-secret", deadlineMs: 20,
  });
  const app = application();
  const accepted = app.incidents.report(incident());
  const input = { incident: accepted.incident, deadlineMs: 20, candidates: [
    { resourceId: "unit", cost: 1, capacity: 1, capabilities: ["ALS"] },
  ] };
  try {
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await client.selectBundle(input)).fallbackReason, "OPTIMIZER_OVERLOADED");
    }
    assert.equal(client.snapshot().circuit, "CLOSED");
    assert.equal(client.snapshot().state, "UP");
  } finally {
    app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("optimizer deadline fallback does not poison the dependency circuit", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      if (response.writableEnded) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    }, 80);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new PythonOptimizerClient({
    url: `http://127.0.0.1:${address.port}`, sharedSecret: "test-secret", deadlineMs: 5,
  });
  const app = application();
  const accepted = app.incidents.report(incident());
  const input = { incident: accepted.incident, deadlineMs: 5, candidates: [
    { resourceId: "unit", cost: 1, capacity: 1, capabilities: ["ALS"] },
  ] };
  try {
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await client.selectBundle(input)).fallbackReason, "OPTIMIZER_DEADLINE_EXCEEDED");
    }
    assert.equal(client.snapshot().circuit, "CLOSED");
  } finally {
    app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
