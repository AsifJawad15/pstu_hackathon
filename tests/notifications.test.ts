import test from "node:test";
import assert from "node:assert/strict";
import { OperationalDatabase } from "../src/platform/database.ts";
import { MemoryNotificationProvider, NotificationOrchestrator } from "../src/services/notifications.ts";

test("notification provider failure falls through and delivery is deduplicated", async () => {
  const database = new OperationalDatabase();
  const failed = new MemoryNotificationProvider("failed", ["SMS"], true);
  const healthy = new MemoryNotificationProvider("healthy", ["SMS"]);
  const service = new NotificationOrchestrator(database, [failed, healthy]);
  const request = {
    notificationId: "notice-1", recipientId: "resource-1", channel: "SMS", version: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), payload: { emergency: true },
  };
  const first = await service.send(request);
  const duplicate = await service.send(request);
  assert.equal(first.provider, "healthy");
  assert.equal(first.status, "ACCEPTED");
  assert.equal(duplicate.duplicate, true);
  assert.equal(healthy.sent.length, 1);
  database.close();
});

test("only approved authorities can issue public warnings", () => {
  const database = new OperationalDatabase();
  const service = new NotificationOrchestrator(database, []);
  const warning = {
    authority: "unknown", severity: "P0" as const,
    area: { latitude: 22, longitude: 91, regionId: "region-a", radiusMeters: 5_000 },
    headline: "Flood", instruction: "Move to high ground", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    channels: ["CAP"],
  };
  assert.throws(() => service.authorizeWarning(warning, new Set(["regional-eoc"])), /cannot issue public warnings/);
  warning.authority = "regional-eoc";
  assert.ok(service.authorizeWarning(warning, new Set(["regional-eoc"])));
  database.close();
});
