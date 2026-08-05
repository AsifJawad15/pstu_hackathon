import test from "node:test";
import assert from "node:assert/strict";
import { ShardDirectory, virtualShard } from "../src/platform/sharding.ts";

test("virtual sharding is deterministic and reasonably distributed", () => {
  assert.equal(virtualShard("region-a", "incident-1"), virtualShard("region-a", "incident-1"));
  const used = new Set(Array.from({ length: 2_000 }, (_, index) => virtualShard("region-a", `incident-${index}`)));
  assert.ok(used.size > 240, `expected broad distribution, received ${used.size} shards`);
});

test("shard moves require the expected epoch and increment it at cutover", () => {
  const directory = new ShardDirectory();
  directory.seed("region-a", "primary", "standby", 2);
  assert.throws(() => directory.beginMove("region-a", 0, "next", 9), /epoch conflict/);
  directory.beginMove("region-a", 0, "next", 1);
  const active = directory.cutover("region-a", 0, 1);
  assert.equal(active.physicalOwner, "next");
  assert.equal(active.epoch, 2);
});

