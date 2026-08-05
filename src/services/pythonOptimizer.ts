import type { Incident, Resource } from "../domain/types.ts";

export type BundleOptimizerCandidate = {
  resourceId: string;
  cost: number;
  capacity: number;
  capabilities: string[];
};

export type BundleOptimizationResult = {
  schemaVersion: 1;
  solverVersion: string;
  algorithm: "EXACT_BOUNDED_DP" | "GREEDY_INCUMBENT" | "NO_FEASIBLE_BUNDLE";
  optimal: boolean;
  feasible: boolean;
  selectedResourceIds: string[];
  objective: number | null;
  coveredCapacity: number;
  examinedStates: number;
  durationMs: number;
  deadlineMs: number;
};

export type BundleOptimizationOutcome = {
  result?: BundleOptimizationResult;
  fallbackReason?: string;
};

export interface BundleOptimizer {
  readonly configured: boolean;
  selectBundle(input: {
    incident: Incident;
    candidates: BundleOptimizerCandidate[];
    deadlineMs: number;
  }): Promise<BundleOptimizationOutcome>;
}

type OptimizerState = "UP" | "DOWN" | "NOT_CONFIGURED";
type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class PythonOptimizerClient implements BundleOptimizer {
  readonly #url: string | undefined;
  readonly #secret: string | undefined;
  readonly #configuredDeadlineMs: number;
  #state: OptimizerState;
  #circuit: CircuitState = "CLOSED";
  #failures = 0;
  #openedAt = 0;
  #calls = 0;
  #successfulCalls = 0;
  #fallbacks = 0;
  #lastError: string | undefined;
  #lastSuccessAt: string | undefined;

  constructor(config: { url?: string; sharedSecret?: string; deadlineMs: number }) {
    this.#url = config.url;
    this.#secret = config.sharedSecret;
    this.#configuredDeadlineMs = Math.max(5, Math.min(500, config.deadlineMs));
    this.#state = this.configured ? "DOWN" : "NOT_CONFIGURED";
  }

  get configured(): boolean { return Boolean(this.#url && this.#secret); }

  async selectBundle(input: {
    incident: Incident;
    candidates: BundleOptimizerCandidate[];
    deadlineMs: number;
  }): Promise<BundleOptimizationOutcome> {
    if (!this.configured) return {};
    this.#calls += 1;
    const now = Date.now();
    if (this.#circuit === "OPEN" && now - this.#openedAt < 10_000) {
      this.#fallbacks += 1;
      return { fallbackReason: "OPTIMIZER_CIRCUIT_OPEN" };
    }
    if (this.#circuit === "OPEN") this.#circuit = "HALF_OPEN";
    const deadlineMs = Math.max(5, Math.min(this.#configuredDeadlineMs, Math.floor(input.deadlineMs)));
    try {
      const response = await fetch(new URL("/v1/solve/bundle", this.#url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-optimizer-token": this.#secret! },
        body: JSON.stringify({
          schemaVersion: 1,
          traceId: input.incident.metadata.traceId,
          incidentId: input.incident.incidentId,
          deadlineMs,
          requiredCapacity: Math.max(1, input.incident.requiredCapacity ?? 1),
          requiredCapabilities: [...new Set(input.incident.requiredCapabilities)].sort(),
          candidates: input.candidates.map((candidate) => ({
            resourceId: candidate.resourceId,
            cost: candidate.cost,
            capacity: candidate.capacity,
            capabilities: [...new Set(candidate.capabilities)].sort(),
          })),
        }),
        signal: AbortSignal.timeout(deadlineMs + 15),
      });
      if (response.status === 429 || response.status === 503) {
        // Reaching a busy optimizer proves the service is alive. Capacity
        // shedding should use the deterministic incumbent without poisoning
        // the dependency circuit as though the process had failed.
        this.#fallbacks += 1;
        this.#state = "UP";
        this.#lastError = `optimizer capacity response HTTP ${response.status}`;
        return { fallbackReason: "OPTIMIZER_OVERLOADED" };
      }
      if (!response.ok) throw new Error(`optimizer returned HTTP ${response.status}`);
      const result = validateResponse(await response.json());
      this.#state = "UP";
      this.#circuit = "CLOSED";
      this.#failures = 0;
      this.#lastError = undefined;
      this.#successfulCalls += 1;
      this.#lastSuccessAt = new Date().toISOString();
      return { result };
    } catch (error) {
      this.#fallbacks += 1;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        // A solver that misses its bounded deadline is a performance fallback,
        // not proof that the dependency is unreachable. Keep serving the
        // deterministic incumbent without poisoning the transport circuit.
        this.#lastError = "optimizer deadline exceeded; deterministic incumbent used";
        return { fallbackReason: "OPTIMIZER_DEADLINE_EXCEEDED" };
      }
      this.#failures += 1;
      this.#state = "DOWN";
      this.#lastError = safeError(error);
      if (this.#failures >= 3) {
        this.#circuit = "OPEN";
        this.#openedAt = Date.now();
      }
      return { fallbackReason: "OPTIMIZER_UNAVAILABLE" };
    }
  }

  async probe(): Promise<void> {
    if (!this.configured) return;
    try {
      const response = await fetch(new URL("/health/ready", this.#url), { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) throw new Error(`optimizer health returned HTTP ${response.status}`);
      this.#state = "UP";
    } catch (error) {
      this.#state = "DOWN";
      this.#lastError = safeError(error);
    }
  }

  snapshot(): {
    configured: boolean;
    state: OptimizerState;
    circuit: CircuitState;
    algorithm: string;
    calls: number;
    successfulCalls: number;
    fallbacks: number;
    lastError?: string;
    lastSuccessAt?: string;
  } {
    const base = {
      configured: this.configured, state: this.#state, circuit: this.#circuit,
      algorithm: "Exact bundle DP + deterministic incumbent", calls: this.#calls,
      successfulCalls: this.#successfulCalls, fallbacks: this.#fallbacks,
    };
    return {
      ...base,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
      ...(this.#lastSuccessAt ? { lastSuccessAt: this.#lastSuccessAt } : {}),
    };
  }
}

function validateResponse(value: unknown): BundleOptimizationResult {
  if (!value || typeof value !== "object") throw new Error("optimizer returned an invalid response");
  const result = value as Partial<BundleOptimizationResult>;
  if (result.schemaVersion !== 1 || typeof result.solverVersion !== "string"
    || !["EXACT_BOUNDED_DP", "GREEDY_INCUMBENT", "NO_FEASIBLE_BUNDLE"].includes(result.algorithm ?? "")
    || typeof result.optimal !== "boolean" || typeof result.feasible !== "boolean"
    || !Array.isArray(result.selectedResourceIds) || !result.selectedResourceIds.every((id) => typeof id === "string")
    || !(result.objective === null || typeof result.objective === "number")
    || !Number.isInteger(result.coveredCapacity) || !Number.isInteger(result.examinedStates)
    || typeof result.durationMs !== "number" || typeof result.deadlineMs !== "number") {
    throw new Error("optimizer returned an incompatible response");
  }
  return result as BundleOptimizationResult;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s/]+/gi, "[optimizer-endpoint]").slice(0, 160);
}
