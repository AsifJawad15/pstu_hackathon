import { randomUUID } from "node:crypto";
import { AppError } from "../domain/errors.ts";
import type { NotificationStatus, PublicWarningInput } from "../domain/types.ts";
import type { OperationalDatabase } from "../platform/database.ts";

export type NotificationRequest = {
  notificationId: string;
  recipientId: string;
  channel: string;
  version: number;
  expiresAt: string;
  payload: unknown;
};

export interface NotificationProvider {
  readonly name: string;
  readonly channels: ReadonlySet<string>;
  send(request: NotificationRequest): Promise<{ providerMessageId: string; status: NotificationStatus }>;
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

  constructor(database: OperationalDatabase, providers: NotificationProvider[]) {
    this.#database = database;
    this.#providers = providers;
  }

  async send(request: NotificationRequest): Promise<{ provider: string; status: NotificationStatus; duplicate: boolean }> {
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
      try {
        const result = await provider.send(request);
        this.#database.setNotificationStatus(request.notificationId, request.recipientId, request.channel,
          request.version, result.status, provider.name);
        return { provider: provider.name, status: result.status, duplicate: false };
      } catch {
        continue;
      }
    }
    this.#database.setNotificationStatus(request.notificationId, request.recipientId, request.channel,
      request.version, "FAILED");
    throw new AppError("ALL_NOTIFICATION_PROVIDERS_FAILED", "All notification providers failed", 503);
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
    const id = input.warningId ?? randomUUID();
    this.#database.createWarning(input, id);
    this.#database.appendAudit(input.authority, "PUBLIC_WARNING_AUTHORIZED", id, input);
    return id;
  }
}
