import { randomUUID } from "node:crypto";
import { AppError } from "../domain/errors.ts";
import type { NotificationStatus, PublicWarningInput } from "../domain/types.ts";
import type { OperationalDatabase } from "../platform/database.ts";
import { uuidv7 } from "../platform/ids.ts";

export type NotificationRequest = {
  notificationId: string;
  recipientId: string;
  channel: string;
  version: number;
  expiresAt: string;
  payload: unknown;
};

export type ProviderFailureCategory = "RATE_LIMIT" | "TIMEOUT" | "UNAVAILABLE" | "UNKNOWN_RESULT" | "PERMANENT";

export class NotificationProviderError extends Error {
  readonly category: ProviderFailureCategory;
  readonly retryAfterMs?: number;
  readonly providerMessageId?: string;

  constructor(message: string, category: ProviderFailureCategory, options: { retryAfterMs?: number; providerMessageId?: string } = {}) {
    super(message);
    this.name = "NotificationProviderError";
    this.category = category;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.providerMessageId !== undefined) this.providerMessageId = options.providerMessageId;
  }
}

export type ProviderCircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

type Circuit = { state: ProviderCircuitState; failures: number; openedAt: number };

export function fullJitterRetryDelayMs(
  attempt: number, retryAfterMs = 0, random: () => number = Math.random,
  baseMs = 250, maximumMs = 30_000,
): number {
  const exponent = Math.max(0, Math.min(16, Math.trunc(attempt) - 1));
  const cap = Math.min(maximumMs, baseMs * (2 ** exponent));
  return Math.max(Math.max(0, retryAfterMs), Math.floor(Math.max(0, Math.min(0.999999, random())) * cap));
}

export interface NotificationProvider {
  readonly name: string;
  readonly channels: ReadonlySet<string>;
  send(request: NotificationRequest): Promise<{ providerMessageId: string; status: NotificationStatus }>;
  getStatus?(providerMessageId: string): Promise<{ providerMessageId: string; status: NotificationStatus } | undefined>;
}

export class MemoryNotificationProvider implements NotificationProvider {
  readonly channels: ReadonlySet<string>;
  readonly sent: NotificationRequest[] = [];
  readonly name: string;
  readonly #fail: boolean;

  constructor(name: string, channels: string[], fail = false) {
    this.name = name;
    this.#fail = fail;
    this.channels = new Set(channels);
  }

  async send(request: NotificationRequest): Promise<{ providerMessageId: string; status: NotificationStatus }> {
    if (this.#fail) throw new Error(`${this.name} unavailable`);
    this.sent.push(request);
    return { providerMessageId: `${this.name}:${randomUUID()}`, status: "ACCEPTED" };
  }
}

export class NotificationOrchestrator {
  readonly #database: OperationalDatabase;
  readonly #providers: NotificationProvider[];
  readonly #circuits = new Map<string, Circuit>();
  readonly #failureThreshold: number;
  readonly #openMs: number;
  readonly #clock: () => number;
  readonly #random: () => number;

  constructor(database: OperationalDatabase, providers: NotificationProvider[], options: {
    failureThreshold?: number; openMs?: number; clock?: () => number; random?: () => number;
  } = {}) {
    this.#database = database;
    this.#providers = providers;
    this.#failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.#openMs = Math.max(1, options.openMs ?? 5_000);
    this.#clock = options.clock ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  async send(request: NotificationRequest): Promise<{
    provider: string; status: NotificationStatus; duplicate: boolean; providerMessageId?: string;
  }> {
    if (Date.parse(request.expiresAt) <= Date.now()) throw new AppError("NOTIFICATION_EXPIRED", "Notification has expired", 410);
    const inserted = this.#database.upsertNotification(request.notificationId, request.recipientId, request.channel,
      request.version, "QUEUED", request.expiresAt);
    if (!inserted.created && !["QUEUED", "FAILED"].includes(inserted.status)) {
      return { provider: "deduplicated", status: inserted.status, duplicate: true };
    }
    if (!this.#database.claimNotification(request.notificationId, request.recipientId, request.channel, request.version)) {
      return { provider: "deduplicated", status: inserted.status, duplicate: true };
    }
    const eligible = this.#providers.filter((provider) => provider.channels.has(request.channel));
    if (eligible.length === 0) throw new AppError("NO_NOTIFICATION_PROVIDER", `No provider supports ${request.channel}`, 503);
    for (const provider of eligible) {
      if (!this.#canAttempt(provider.name)) continue;
      const startedAt = new Date(this.#clock()).toISOString();
      try {
        const result = await provider.send(request);
        this.#recordSuccess(provider.name);
        this.#database.recordNotificationAttempt(request, provider.name, "ACCEPTED", startedAt, {
          providerMessageId: result.providerMessageId,
        });
        this.#database.setNotificationStatus(request.notificationId, request.recipientId, request.channel,
          request.version, result.status, provider.name);
        return { provider: provider.name, status: result.status, duplicate: false, providerMessageId: result.providerMessageId };
      } catch (error) {
        const failure = normalizeProviderError(error);
        this.#recordFailure(provider.name);
        if (failure.category === "UNKNOWN_RESULT" && failure.providerMessageId && provider.getStatus) {
          const reconciled = await provider.getStatus(failure.providerMessageId).catch(() => undefined);
          if (reconciled && ["ACCEPTED", "DELIVERED", "ACKNOWLEDGED"].includes(reconciled.status)) {
            this.#recordSuccess(provider.name);
            this.#database.recordNotificationAttempt(request, provider.name, "RECONCILED", startedAt, {
              providerMessageId: reconciled.providerMessageId,
            });
            this.#database.setNotificationStatus(request.notificationId, request.recipientId, request.channel,
              request.version, reconciled.status, provider.name);
            return { provider: provider.name, status: reconciled.status, duplicate: false,
              providerMessageId: reconciled.providerMessageId };
          }
        }
        const delayMs = fullJitterRetryDelayMs(1, failure.retryAfterMs, this.#random);
        const nextRetryAt = new Date(Math.min(Date.parse(request.expiresAt), this.#clock() + delayMs)).toISOString();
        this.#database.recordNotificationAttempt(request, provider.name, failure.category, startedAt, {
          error: failure.message, nextRetryAt,
          ...(failure.providerMessageId ? { providerMessageId: failure.providerMessageId } : {}),
        });
        continue;
      }
    }
    this.#database.setNotificationStatus(request.notificationId, request.recipientId, request.channel,
      request.version, "FAILED");
    throw new AppError("ALL_NOTIFICATION_PROVIDERS_FAILED", "All notification providers failed", 503);
  }

  providerCircuitState(provider: string): ProviderCircuitState {
    const circuit = this.#circuits.get(provider);
    if (!circuit) return "CLOSED";
    if (circuit.state === "OPEN" && this.#clock() - circuit.openedAt >= this.#openMs) return "HALF_OPEN";
    return circuit.state;
  }

  applyProviderStatus(input: {
    eventId: string; notificationId: string; recipientId: string; channel: string; version: number;
    provider: string; providerMessageId: string; status: NotificationStatus; occurredAt: string;
  }): { applied: boolean; status: NotificationStatus } {
    return this.#database.applyProviderNotificationStatus(input);
  }

  #canAttempt(provider: string): boolean {
    const circuit = this.#circuits.get(provider);
    if (!circuit || circuit.state === "CLOSED") return true;
    if (circuit.state === "OPEN" && this.#clock() - circuit.openedAt >= this.#openMs) {
      circuit.state = "HALF_OPEN";
      return true;
    }
    return false;
  }

  #recordSuccess(provider: string): void {
    this.#circuits.set(provider, { state: "CLOSED", failures: 0, openedAt: 0 });
  }

  #recordFailure(provider: string): void {
    const current = this.#circuits.get(provider) ?? { state: "CLOSED" as const, failures: 0, openedAt: 0 };
    const failures = current.failures + 1;
    this.#circuits.set(provider, failures >= this.#failureThreshold
      ? { state: "OPEN", failures, openedAt: this.#clock() }
      : { state: "CLOSED", failures, openedAt: 0 });
  }

  authorizeWarning(input: PublicWarningInput, allowedAuthorities: ReadonlySet<string>): string {
    if (!allowedAuthorities.has(input.authority)) throw new AppError("WARNING_NOT_AUTHORIZED", "Authority cannot issue public warnings", 403);
    if (Date.parse(input.expiresAt) <= Date.now()) throw new AppError("WARNING_EXPIRED", "Warning expiry must be in the future", 422);
    if (input.headline.length < 3 || input.headline.length > 160 || input.instruction.length < 3 || input.instruction.length > 2_000) {
      throw new AppError("WARNING_CONTENT_INVALID", "Warning headline or instruction is outside its bounded length", 422);
    }
    if (input.channels.length === 0 || input.channels.length > 8) {
      throw new AppError("WARNING_CHANNELS_INVALID", "One to eight warning channels are required", 422);
    }
    if (!Number.isFinite(input.area.radiusMeters) || input.area.radiusMeters <= 0 || input.area.radiusMeters > 1_000_000) {
      throw new AppError("WARNING_AREA_INVALID", "Warning radius is invalid", 422);
    }
    const id = input.warningId ?? uuidv7();
    this.#database.createWarning(input, id);
    this.#database.appendAudit(input.authority, "PUBLIC_WARNING_AUTHORIZED", id, input);
    return id;
  }
}

function normalizeProviderError(error: unknown): NotificationProviderError {
  if (error instanceof NotificationProviderError) return error;
  return new NotificationProviderError(error instanceof Error ? error.message : "Provider unavailable", "UNAVAILABLE");
}
