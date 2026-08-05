import test from "node:test";
import assert from "node:assert/strict";
import { OperationalDatabase } from "../src/platform/database.ts";
import {
  fullJitterRetryDelayMs, MemoryNotificationProvider, NotificationOrchestrator, NotificationProviderError,
  type NotificationProvider, type NotificationRequest,
} from "../src/services/notifications.ts";

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

test("an open provider circuit skips repeated slow failures and recovers through half-open", async () => {
  const database = new OperationalDatabase();
  let now = 1_000;
  const failed = new MemoryNotificationProvider("failed", ["SMS"], true);
  const healthy = new MemoryNotificationProvider("healthy", ["SMS"]);
  const service = new NotificationOrchestrator(database, [failed, healthy], {
    failureThreshold: 1, openMs: 5_000, clock: () => now, random: () => 0,
  });
  const request = (id: string): NotificationRequest => ({
    notificationId: id, recipientId: "resource-1", channel: "SMS", version: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), payload: {},
  });
  await service.send(request("circuit-1"));
  assert.equal(service.providerCircuitState("failed"), "OPEN");
  await service.send(request("circuit-2"));
  assert.equal(healthy.sent.length, 2);
  now += 5_001;
  assert.equal(service.providerCircuitState("failed"), "HALF_OPEN");
  await service.send(request("circuit-3"));
  assert.equal(service.providerCircuitState("failed"), "OPEN");
  database.close();
});

test("unknown provider result is reconciled before another provider can duplicate delivery", async () => {
  const database = new OperationalDatabase();
  const uncertain: NotificationProvider = {
    name: "uncertain", channels: new Set(["SMS"]),
    async send() { throw new NotificationProviderError("timeout after submit", "UNKNOWN_RESULT", { providerMessageId: "provider-1" }); },
    async getStatus() { return { providerMessageId: "provider-1", status: "DELIVERED" }; },
  };
  const backup = new MemoryNotificationProvider("backup", ["SMS"]);
  const service = new NotificationOrchestrator(database, [uncertain, backup]);
  const result = await service.send({
    notificationId: "unknown-1", recipientId: "resource-1", channel: "SMS", version: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), payload: {},
  });
  assert.equal(result.status, "DELIVERED");
  assert.equal(backup.sent.length, 0);
  database.close();
});

test("provider callbacks are idempotent and cannot move a delivered notification backwards", async () => {
  const database = new OperationalDatabase();
  const provider: NotificationProvider = {
    name: "primary", channels: new Set(["SMS"]),
    async send() { return { providerMessageId: "message-1", status: "ACCEPTED" }; },
  };
  const service = new NotificationOrchestrator(database, [provider]);
  const request = {
    notificationId: "callback-1", recipientId: "resource-1", channel: "SMS", version: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), payload: {},
  };
  await service.send(request);
  const delivered = service.applyProviderStatus({ eventId: "event-1", provider: "primary", providerMessageId: "message-1",
    notificationId: request.notificationId, recipientId: request.recipientId, channel: request.channel, version: 1,
    status: "DELIVERED", occurredAt: new Date().toISOString() });
  const duplicate = service.applyProviderStatus({ eventId: "event-1", provider: "primary", providerMessageId: "message-1",
    notificationId: request.notificationId, recipientId: request.recipientId, channel: request.channel, version: 1,
    status: "DELIVERED", occurredAt: new Date().toISOString() });
  const stale = service.applyProviderStatus({ eventId: "event-2", provider: "primary", providerMessageId: "message-1",
    notificationId: request.notificationId, recipientId: request.recipientId, channel: request.channel, version: 1,
    status: "ACCEPTED", occurredAt: new Date().toISOString() });
  assert.deepEqual(delivered, { applied: true, status: "DELIVERED" });
  assert.equal(duplicate.applied, false);
  assert.deepEqual(stale, { applied: false, status: "DELIVERED" });
  database.close();
});

test("a late callback from a failed provider cannot regress the active fallback delivery", async () => {
  const database = new OperationalDatabase();
  const failed = new MemoryNotificationProvider("failed", ["SMS"], true);
  const healthy: NotificationProvider = {
    name: "healthy", channels: new Set(["SMS"]),
    async send() { return { providerMessageId: "healthy-message", status: "ACCEPTED" }; },
  };
  const service = new NotificationOrchestrator(database, [failed, healthy]);
  const request = { notificationId: "cross-provider-1", recipientId: "resource-1", channel: "SMS", version: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), payload: {} };
  await service.send(request);
  const late = service.applyProviderStatus({ eventId: "failed-event", provider: "failed", providerMessageId: "old-message",
    notificationId: request.notificationId, recipientId: request.recipientId, channel: request.channel, version: 1,
    status: "FAILED", occurredAt: new Date().toISOString() });
  assert.deepEqual(late, { applied: false, status: "ACCEPTED" });
  database.close();
});

test("retry delay honors Retry-After and remains bounded", () => {
  assert.equal(fullJitterRetryDelayMs(1, 2_000, () => 0.5), 2_000);
  assert.equal(fullJitterRetryDelayMs(20, 0, () => 0.999999), 29_999);
});
