import { AppError, invariant } from "../domain/errors.ts";
import type { GeoPoint, Resource, ResourceTelemetryInput } from "../domain/types.ts";
import type { OperationalDatabase } from "../platform/database.ts";
import { neighboringCells } from "../platform/spatial.ts";

export class ResourceIndex {
  readonly #resources = new Map<string, Resource>();
  readonly #cells = new Map<string, Set<string>>();

  update(resource: Resource): void {
    const previous = this.#resources.get(resource.resourceId);
    if (previous && previous.spatialCell !== resource.spatialCell) {
      this.#cells.get(previous.spatialCell)?.delete(resource.resourceId);
    }
    this.#resources.set(resource.resourceId, Object.freeze({ ...resource }));
    const ids = this.#cells.get(resource.spatialCell) ?? new Set<string>();
    ids.add(resource.resourceId);
    this.#cells.set(resource.spatialCell, ids);
  }

  get(resourceId: string): Resource | undefined { return this.#resources.get(resourceId); }

  search(location: GeoPoint, maximum: number, maxRings = 25): Resource[] {
    const found = new Set<string>();
    for (let ring = 0; ring <= maxRings && found.size < maximum; ring += 1) {
      for (const cell of neighboringCells(location, ring)) {
        for (const id of this.#cells.get(cell) ?? []) found.add(id);
      }
    }
    return [...found].map((id) => this.#resources.get(id)).filter((value): value is Resource => Boolean(value));
  }

  rebuild(resources: Resource[]): void {
    this.#resources.clear();
    this.#cells.clear();
    resources.sort((a, b) => a.resourceId.localeCompare(b.resourceId)).forEach((resource) => this.update(resource));
  }

  size(): number { return this.#resources.size; }
}

export class ResourceService {
  readonly #database: OperationalDatabase;
  readonly index: ResourceIndex;

  constructor(database: OperationalDatabase, index: ResourceIndex) {
    this.#database = database;
    this.index = index;
  }

  ingest(input: ResourceTelemetryInput): { resource: Resource; applied: boolean } {
    validateTelemetry(input);
    const result = this.#database.upsertResource(input);
    if (result.applied) this.index.update(result.resource);
    return result;
  }

  rebuild(regionId: string): number {
    const resources = this.#database.listResources(regionId);
    this.index.rebuild(resources);
    return resources.length;
  }
}

function validateTelemetry(input: ResourceTelemetryInput): void {
  invariant(input.resourceId.length >= 3 && input.resourceId.length <= 128, "INVALID_RESOURCE_ID", "Resource ID is invalid");
  invariant(Number.isInteger(input.sourceSequence) && input.sourceSequence >= 0, "INVALID_SEQUENCE", "Source sequence is invalid");
  invariant(Number.isFinite(input.location.latitude) && input.location.latitude >= -90 && input.location.latitude <= 90,
    "INVALID_LOCATION", "Latitude is invalid");
  invariant(Number.isFinite(input.location.longitude) && input.location.longitude >= -180 && input.location.longitude <= 180,
    "INVALID_LOCATION", "Longitude is invalid");
  invariant(input.capabilities.length <= 64 && input.capabilities.every((value) => value.length > 0 && value.length <= 64),
    "INVALID_CAPABILITIES", "Resource capabilities are invalid");
  invariant(Number.isInteger(input.capacity) && input.capacity >= 0 && input.capacity <= 100_000,
    "INVALID_CAPACITY", "Resource capacity is invalid");
  if (input.metadata.expiryTime && Date.parse(input.metadata.expiryTime) <= Date.now()) {
    throw new AppError("EXPIRED_TELEMETRY", "Telemetry event has expired", 410);
  }
}
