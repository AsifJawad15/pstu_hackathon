import test from "node:test";
import assert from "node:assert/strict";
import { OperationalDatabase } from "../src/platform/database.ts";
import { EncryptedEdgeSpool } from "../src/platform/edgeSpool.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { CommandSigner } from "../src/platform/signing.ts";
import { BoundedEventBus, OutboxPublisher } from "../src/platform/eventBus.ts";
import { LocalRoutingService, spatialCell } from "../src/platform/spatial.ts";

test("consumer deduplication and audit chaining are stable", () => {
  const database = new OperationalDatabase();
  assert.equal(database.processOnce("projector", "event-1"), true);
  assert.equal(database.processOnce("projector", "event-1"), false);
  database.appendAudit("operator", "TEST", "target", { safe: true });
  database.appendAudit("operator", "TEST_2", "target", { safe: true });
  assert.equal(database.auditIntegrity(), true);
  database.close();
});

test("edge spool encrypts and drains records", () => {
  const path = join(tmpdir(), `edge-spool-${crypto.randomUUID()}.ndjson`);
  const spool = new EncryptedEdgeSpool(path, "11".repeat(32));
  spool.append({ incidentId: "incident-1", severity: 9 });
  assert.deepEqual(spool.drain(), [{ incidentId: "incident-1", severity: 9 }]);
  assert.deepEqual(spool.drain(), []);
  rmSync(path, { force: true });
});

test("command signatures are canonical and tamper evident", () => {
  const signer = new CommandSigner("test-signing-key-with-more-than-32-characters");
  const command = { resourceId: "resource-1", epoch: 8, action: "DISPATCH" };
  const signature = signer.sign(command);
  assert.equal(signer.verify({ ...command, signature }), true);
  assert.equal(signer.verify({ ...command, epoch: 9, signature }), false);
});

test("concurrent outbox flush requests share one bounded publication pass", async () => {
  const database = new OperationalDatabase();
  const bus = new BoundedEventBus();
  let deliveries = 0;
  bus.subscribe("*", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    deliveries += 1;
  });
  database.addOutbox("TEST", "aggregate-1", "TestEvent", { value: 1 });
  const publisher = new OutboxPublisher(database, bus);
  const [first, second] = await Promise.all([publisher.flush(), publisher.flush()]);
  assert.deepEqual(first, { published: 1, failed: 0 });
  assert.deepEqual(second, first);
  assert.equal(deliveries, 1);
  assert.equal(database.pendingOutbox().length, 0);
  database.close();
});

test("active road state is replayable and expires without blocking air routes", async () => {
  const database = new OperationalDatabase();
  const point = { latitude: 22.47, longitude: 91.78, regionId: "region-a" };
  const closedCell = spatialCell(point);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  database.addEnvironmentEvent({
    eventId: "closure-replay", regionId: "region-a", eventType: "ROAD_CLOSURE",
    payload: { reason: "test" }, mapVersion: "map-closure", effectiveAt: new Date().toISOString(),
    expiresAt, closedCells: [closedCell],
  });
  const restored = database.latestActiveEnvironment("region-a");
  assert.deepEqual(restored, { mapVersion: "map-closure", expiresAt, closedCells: [closedCell] });
  const routing = new LocalRoutingService();
  routing.replaceClosures(restored!.closedCells, restored!.mapVersion, restored!.expiresAt);
  assert.equal((await routing.estimate(point, point, 50, "GROUND")).etaSeconds, Number.POSITIVE_INFINITY);
  assert.ok(Number.isFinite((await routing.estimate(point, point, 50, "AIR")).etaSeconds));
  routing.replaceClosures([closedCell], "expired-map", new Date(Date.now() - 1).toISOString());
  assert.ok(Number.isFinite((await routing.estimate(point, point, 50, "GROUND")).etaSeconds));
  database.close();
});
