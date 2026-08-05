import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OperationalDatabase } from "../src/platform/database.ts";

test("legacy assignment schema is upgraded without deleting operational data", () => {
  const directory = mkdtempSync(join(tmpdir(), "emergency-migration-"));
  const path = join(directory, "legacy.db");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE assignments (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        status TEXT NOT NULL,
        resource_epoch INTEGER NOT NULL,
        shard_epoch INTEGER NOT NULL,
        resource_version INTEGER NOT NULL,
        command_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO assignments VALUES
        ('assignment-before-upgrade','incident-1','resource-1','COMPLETED',1,1,1,'command-1','2026-01-01','2026-01-01');
    `);
    legacy.close();

    const upgraded = new OperationalDatabase(path);
    const columns = upgraded.db.prepare("PRAGMA table_info(assignments)").all()
      .map((entry) => String(entry.name));
    assert.ok(columns.includes("facility_id"));
    assert.ok(columns.includes("facility_capability"));
    assert.equal(upgraded.db.prepare("SELECT count(*) AS count FROM assignments").get()!.count, 1);
    assert.equal(upgraded.db.prepare("PRAGMA user_version").get()!.user_version, 2);
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
