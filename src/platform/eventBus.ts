import { AppError } from "../domain/errors.ts";
import type { OperationalDatabase } from "./database.ts";

export type EventEnvelope = { id: string; type: string; payload: unknown };
export type EventHandler = (event: EventEnvelope) => void | Promise<void>;

export class BoundedEventBus {
  readonly #handlers = new Map<string, Set<EventHandler>>();
  #inFlight = 0;
  readonly #capacity: number;

  constructor(capacity = 10_000) { this.#capacity = capacity; }

  subscribe(eventType: string, handler: EventHandler): () => void {
    const handlers = this.#handlers.get(eventType) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.#handlers.set(eventType, handlers);
    return () => handlers.delete(handler);
  }

  async publish(event: EventEnvelope): Promise<void> {
    if (this.#inFlight >= this.#capacity) throw new AppError("EVENT_BUS_OVERLOADED", "Event bus capacity exhausted", 503);
    this.#inFlight += 1;
    try {
      const handlers = [...(this.#handlers.get(event.type) ?? []), ...(this.#handlers.get("*") ?? [])];
      await Promise.all(handlers.map((handler) => handler(event)));
    } finally {
      this.#inFlight -= 1;
    }
  }
}

export class OutboxPublisher {
  readonly #database: OperationalDatabase;
  readonly #bus: BoundedEventBus;
  #active: Promise<{ published: number; failed: number }> | undefined;

  constructor(database: OperationalDatabase, bus: BoundedEventBus) {
    this.#database = database;
    this.#bus = bus;
  }

  flush(limit = 100): Promise<{ published: number; failed: number }> {
    if (this.#active) return this.#active;
    const active = this.#flush(limit);
    this.#active = active;
    void active.then(() => {
      if (this.#active === active) this.#active = undefined;
    }, () => {
      if (this.#active === active) this.#active = undefined;
    });
    return active;
  }

  async #flush(limit: number): Promise<{ published: number; failed: number }> {
    const publishedIds: string[] = [];
    let failed = 0;
    for (const entry of this.#database.pendingOutbox(limit)) {
      try {
        await this.#bus.publish({ id: entry.id, type: entry.eventType, payload: entry.payload });
        publishedIds.push(entry.id);
      } catch (error) {
        this.#database.markOutboxFailed(entry.id, error instanceof Error ? error.message : "unknown error");
        failed += 1;
      }
    }
    if (publishedIds.length > 0) {
      try {
        // A single bounded SQLite update avoids blocking incident intake once
        // per event while retaining at-least-once replay semantics.
        this.#database.markOutboxPublishedBatch(publishedIds);
      } catch (error) {
        for (const id of publishedIds) {
          this.#database.markOutboxFailed(id, error instanceof Error ? error.message : "publish acknowledgement failed");
        }
        failed += publishedIds.length;
        return { published: 0, failed };
      }
    }
    return { published: publishedIds.length, failed };
  }
}
