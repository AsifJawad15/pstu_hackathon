import { createHash } from "node:crypto";

export const DEFAULT_VIRTUAL_SHARDS = 256;

export function virtualShard(regionId: string, entityId: string, count = DEFAULT_VIRTUAL_SHARDS): number {
  if (!Number.isInteger(count) || count <= 0) throw new RangeError("Virtual shard count must be positive");
  const digest = createHash("sha256").update(regionId).update("\0").update(entityId).digest();
  return digest.readUInt32BE(0) % count;
}

export type ShardOwner = {
  regionId: string;
  virtualShard: number;
  physicalOwner: string;
  standbyOwner: string;
  epoch: number;
  state: "ACTIVE" | "MOVING" | "READ_ONLY" | "FENCED";
};

export class ShardDirectory {
  readonly #owners = new Map<string, ShardOwner>();

  #key(regionId: string, shard: number): string {
    return `${regionId}:${shard}`;
  }

  seed(regionId: string, physicalOwner: string, standbyOwner: string, count = DEFAULT_VIRTUAL_SHARDS): void {
    for (let shard = 0; shard < count; shard += 1) {
      this.#owners.set(this.#key(regionId, shard), {
        regionId, virtualShard: shard, physicalOwner, standbyOwner, epoch: 1, state: "ACTIVE",
      });
    }
  }

  owner(regionId: string, shard: number): Readonly<ShardOwner> {
    const owner = this.#owners.get(this.#key(regionId, shard));
    if (!owner) throw new Error(`No owner for ${regionId}:${shard}`);
    return owner;
  }

  beginMove(regionId: string, shard: number, destination: string, expectedEpoch: number): Readonly<ShardOwner> {
    const current = this.owner(regionId, shard);
    if (current.epoch !== expectedEpoch || current.state !== "ACTIVE") throw new Error("Shard epoch conflict");
    const next: ShardOwner = { ...current, standbyOwner: destination, state: "MOVING" };
    this.#owners.set(this.#key(regionId, shard), next);
    return next;
  }

  cutover(regionId: string, shard: number, expectedEpoch: number): Readonly<ShardOwner> {
    const current = this.owner(regionId, shard);
    if (current.epoch !== expectedEpoch || current.state !== "MOVING") throw new Error("Shard is not ready for cutover");
    const next: ShardOwner = {
      ...current,
      physicalOwner: current.standbyOwner,
      standbyOwner: current.physicalOwner,
      epoch: current.epoch + 1,
      state: "ACTIVE",
    };
    this.#owners.set(this.#key(regionId, shard), next);
    return next;
  }
}

