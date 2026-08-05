import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { EmergencyApplication } from "../src/application.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpServer } from "../src/http.ts";
import { OperationalDatabase } from "../src/platform/database.ts";
import { incident, resource } from "./fixtures.ts";

test("HTTP boundary authenticates, accepts, allocates and exposes readiness", async () => {
  const config = loadConfig({
    HOST: "127.0.0.1", PORT: "8080", REGION_ID: "region-a", DATABASE_PATH: ":memory:",
    EMERGENCY_API_TOKEN: "integration-token", COMMAND_SIGNING_KEY: "integration-command-signing-key-123456789",
  });
  const app = new EmergencyApplication(config, new OperationalDatabase());
  app.resources.ingest(resource("ambulance-http"));
  const server = createHttpServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json() as { auditIntegrity: boolean }).auditIntegrity, true);

  const denied = await fetch(`${base}/v1/incidents`, { method: "POST", body: JSON.stringify(incident()) });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${base}/v1/incidents`, {
    method: "POST",
    headers: { authorization: "Bearer integration-token", "content-type": "application/json" },
    body: JSON.stringify(incident({ autoAllocate: true })),
  });
  assert.equal(accepted.status, 202);
  const body = await accepted.json() as { status: string; allocation: { assignments: unknown[] } };
  assert.equal(body.status, "ACCEPTED");
  assert.equal(body.allocation.assignments.length, 1);

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  app.close();
});
