import test from "node:test";
import assert from "node:assert/strict";
import { uuidv7 } from "../src/platform/ids.ts";

test("UUIDv7 identifiers carry the expected version, variant, and timestamp ordering", () => {
  const earlier = uuidv7(1_700_000_000_000);
  const later = uuidv7(1_700_000_000_001);
  assert.match(earlier, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(earlier < later);
});
