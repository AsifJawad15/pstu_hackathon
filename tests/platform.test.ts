import test from "node:test";
import assert from "node:assert/strict";
import { OperationalDatabase } from "../src/platform/database.ts";
import { EncryptedEdgeSpool } from "../src/platform/edgeSpool.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { CommandSigner } from "../src/platform/signing.ts";

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
