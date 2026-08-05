import type { GeoPoint, TransportMode } from "../domain/types.ts";

const EARTH_RADIUS_METERS = 6_371_000;

export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Dependency-free local grid used by the reference runtime. Production replaces this
// adapter with H3 while preserving the same expanding-ring interface.
export function spatialCell(point: GeoPoint, resolution = 100): string {
  const lat = Math.floor((point.latitude + 90) * resolution);
  const lon = Math.floor((point.longitude + 180) * resolution);
  return `${point.regionId}:${lat}:${lon}`;
}

export function neighboringCells(point: GeoPoint, rings: number, resolution = 100): Set<string> {
  const lat = Math.floor((point.latitude + 90) * resolution);
  const lon = Math.floor((point.longitude + 180) * resolution);
  const result = new Set<string>();
  for (let x = lat - rings; x <= lat + rings; x += 1) {
    for (let y = lon - rings; y <= lon + rings; y += 1) {
      if (Math.max(Math.abs(x - lat), Math.abs(y - lon)) <= rings) result.add(`${point.regionId}:${x}:${y}`);
    }
  }
  return result;
}

export type RouteEstimate = {
  etaSeconds: number;
  distanceMeters: number;
  confidence: number;
  source: "LOCAL_MATRIX" | "LOCAL_GRAPH" | "GEOMETRIC_FALLBACK";
};

export interface RouteProvider {
  estimate(from: GeoPoint, to: GeoPoint, deadlineMs: number, transportMode?: TransportMode): Promise<RouteEstimate>;
}

export class LocalRoutingService implements RouteProvider {
  readonly #closures = new Set<string>();
  #mapVersion = "map-1";
  #closuresExpireAt = Number.POSITIVE_INFINITY;

  get mapVersion(): string { return this.#mapVersion; }

  replaceClosures(cells: string[], version: string, expiresAt?: string): void {
    this.#closures.clear();
    cells.forEach((cell) => this.#closures.add(cell));
    this.#mapVersion = version;
    const parsedExpiry = expiresAt ? Date.parse(expiresAt) : Number.POSITIVE_INFINITY;
    this.#closuresExpireAt = Number.isFinite(parsedExpiry) ? parsedExpiry : Number.POSITIVE_INFINITY;
  }

  async estimate(from: GeoPoint, to: GeoPoint, deadlineMs: number, transportMode: TransportMode = "GROUND"): Promise<RouteEstimate> {
    const distance = distanceMeters(from, to);
    // Air transport ignores road closures
    if (transportMode !== "AIR") {
      if (this.#closures.size > 0 && Date.now() >= this.#closuresExpireAt) this.#closures.clear();
      const closed = this.#closures.has(spatialCell(from)) || this.#closures.has(spatialCell(to));
      if (closed) return { etaSeconds: Number.POSITIVE_INFINITY, distanceMeters: distance, confidence: 0, source: "LOCAL_GRAPH" };
    }
    if (deadlineMs <= 0) return this.fallback(from, to, transportMode);
    const speeds: Record<TransportMode, { factor: number; mps: number; confidence: number }> = {
      GROUND: { factor: 1.35, mps: 11.1, confidence: 0.8 },
      AIR:    { factor: 1.05, mps: 55.6, confidence: 0.7 },  // ~200 km/h helicopter
      WATER:  { factor: 1.5,  mps: 8.3,  confidence: 0.6 },
    };
    const params = speeds[transportMode];
    return {
      etaSeconds: Math.ceil(distance * params.factor / params.mps),
      distanceMeters: distance,
      confidence: params.confidence,
      source: "LOCAL_GRAPH",
    };
  }

  fallback(from: GeoPoint, to: GeoPoint, transportMode: TransportMode = "GROUND"): RouteEstimate {
    const distance = distanceMeters(from, to);
    const fallbackSpeeds: Record<TransportMode, { factor: number; mps: number }> = {
      GROUND: { factor: 1.8, mps: 8.3 },
      AIR:    { factor: 1.1, mps: 44.4 },
      WATER:  { factor: 2.0, mps: 5.5 },
    };
    const params = fallbackSpeeds[transportMode];
    return {
      etaSeconds: Math.ceil(distance * params.factor / params.mps),
      distanceMeters: distance,
      confidence: 0.4,
      source: "GEOMETRIC_FALLBACK",
    };
  }
}
