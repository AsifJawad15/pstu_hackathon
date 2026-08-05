import { hostname } from "node:os";
import { Pool } from "pg";
import { Kafka, Partitioners, type Admin, type Producer } from "kafkajs";
import { createClient, type RedisClientType } from "redis";
import { Etcd3, type Lease } from "etcd3";
import type { AppConfig } from "../config.ts";
import type { BoundedEventBus, EventEnvelope } from "./eventBus.ts";

type IntegrationName = "postgres" | "kafka" | "redis" | "etcd";
type IntegrationState = "UP" | "DOWN" | "NOT_CONFIGURED";

type IntegrationStatus = {
  name: IntegrationName;
  label: string;
  purpose: string;
  critical: boolean;
  state: IntegrationState;
  lastError?: string;
};

export class ProductionIntegrations {
  readonly #config: AppConfig["productionIntegrations"];
  readonly #statuses = new Map<IntegrationName, IntegrationStatus>();
  #postgres?: Pool;
  #kafka?: Producer;
  #kafkaAdmin?: Admin;
  #redis?: RedisClientType;
  #etcd?: Etcd3;
  #etcdLease?: Lease;
  #etcdRegistrationKey?: string;
  #unsubscribe?: () => void;
  #healthTimer?: NodeJS.Timeout;
  #probing = false;
  #publishedEvents = 0;
  #lastPublishedAt?: string;

  constructor(config: AppConfig["productionIntegrations"]) {
    this.#config = config;
    this.#statuses.set("postgres", status("postgres", "PostgreSQL / PostGIS", "Durable replay and operational schema", true,
      config.postgresUrl ? "DOWN" : "NOT_CONFIGURED"));
    this.#statuses.set("kafka", status("kafka", "Kafka quorum", "Durable prioritized event distribution", true,
      config.kafkaBrokers.length ? "DOWN" : "NOT_CONFIGURED"));
    this.#statuses.set("redis", status("redis", "Redis projection", "Disposable low-latency latest-event cache", false,
      config.redisUrl ? "DOWN" : "NOT_CONFIGURED"));
    this.#statuses.set("etcd", status("etcd", "etcd ownership", "Shard ownership and fencing directory", true,
      config.etcdHosts.length ? "DOWN" : "NOT_CONFIGURED"));
  }

  async start(bus: BoundedEventBus, regionId: string): Promise<void> {
    await Promise.allSettled([
      this.#connectPostgres(), this.#connectKafka(), this.#connectRedis(), this.#connectEtcd(regionId),
    ]);
    this.#unsubscribe = bus.subscribe("*", (event) => this.publish(event, regionId));
    this.#healthTimer = setInterval(() => { void this.#probe(regionId); }, 5_000);
    this.#healthTimer.unref();
  }

  async publish(event: EventEnvelope, regionId: string): Promise<void> {
    if (!this.configured) return;
    const payload = JSON.stringify(event.payload);
    const criticalTasks: Promise<unknown>[] = [];
    if (this.#postgres) {
      criticalTasks.push(this.#postgres.query(`INSERT INTO integration_events(event_id,event_type,region_id,payload)
        VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(event_id) DO NOTHING`, [event.id, event.type, regionId, payload])
        .then(() => this.#markUp("postgres")).catch((error: unknown) => { this.#markDown("postgres", error); throw error; }));
    } else if (this.#config.postgresUrl) criticalTasks.push(Promise.reject(new Error("PostgreSQL integration is unavailable")));
    if (this.#kafka) {
      const topic = criticalEvent(event) ? "emergency.critical.v1" : "emergency.operational.v1";
      criticalTasks.push(this.#kafka.send({ topic, acks: -1, messages: [{ key: event.id, value: JSON.stringify({ ...event, regionId }) }] })
        .then(() => this.#markUp("kafka")).catch((error: unknown) => { this.#markDown("kafka", error); throw error; }));
    } else if (this.#config.kafkaBrokers.length) criticalTasks.push(Promise.reject(new Error("Kafka integration is unavailable")));
    if (this.#redis) {
      this.#redis.set(`emergency:${regionId}:latest:${event.type}`, payload, { EX: 300 })
        .then(() => this.#markUp("redis")).catch((error: unknown) => this.#markDown("redis", error));
    }
    await Promise.all(criticalTasks);
    this.#publishedEvents += 1;
    this.#lastPublishedAt = new Date().toISOString();
  }

  snapshot(localBacklog: number): {
    mode: "LOCAL_REFERENCE" | "PRODUCTION_DEMO";
    overall: "LOCAL_ONLY" | "READY" | "DEGRADED";
    localAuthority: string;
    integrations: IntegrationStatus[];
    publishedEvents: number;
    lastPublishedAt?: string;
    retainedOutboxEvents: number;
  } {
    const integrations = [...this.#statuses.values()];
    const configured = integrations.filter((item) => item.state !== "NOT_CONFIGURED");
    const criticalDown = configured.some((item) => item.critical && item.state === "DOWN");
    const base = {
      mode: this.configured ? "PRODUCTION_DEMO" as const : "LOCAL_REFERENCE" as const,
      overall: !this.configured ? "LOCAL_ONLY" as const : criticalDown ? "DEGRADED" as const : "READY" as const,
      localAuthority: "SQLite reference transaction store",
      integrations,
      publishedEvents: this.#publishedEvents,
      retainedOutboxEvents: localBacklog,
    };
    return this.#lastPublishedAt ? { ...base, lastPublishedAt: this.#lastPublishedAt } : base;
  }

  get configured(): boolean {
    return Boolean(this.#config.postgresUrl || this.#config.kafkaBrokers.length || this.#config.redisUrl || this.#config.etcdHosts.length);
  }

  async close(): Promise<void> {
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    this.#unsubscribe?.();
    if (this.#etcdLease) await this.#etcdLease.revoke().catch(() => undefined);
    await Promise.allSettled([
      this.#postgres?.end(), this.#kafka?.disconnect(), this.#kafkaAdmin?.disconnect(),
      this.#redis?.quit(), Promise.resolve(this.#etcd?.close()),
    ]);
  }

  async #connectPostgres(): Promise<void> {
    if (!this.#config.postgresUrl) return;
    try {
      const pool = new Pool({ connectionString: this.#config.postgresUrl, max: 8, connectionTimeoutMillis: 2_000,
        idleTimeoutMillis: 30_000, application_name: "emergency-api" });
      await pool.query("SELECT 1");
      this.#postgres = pool;
      this.#markUp("postgres");
    } catch (error) { this.#markDown("postgres", error); }
  }

  async #connectKafka(): Promise<void> {
    if (!this.#config.kafkaBrokers.length) return;
    try {
      const client = new Kafka({ clientId: `emergency-api-${hostname()}`, brokers: this.#config.kafkaBrokers,
        connectionTimeout: 2_000, requestTimeout: 5_000, retry: { initialRetryTime: 200, retries: 5 } });
      // Distribution is intentionally at-least-once. Event IDs and consumer-side
      // deduplication provide safe replay without an unbounded transactional-producer retry.
      const producer = client.producer({ allowAutoTopicCreation: false, createPartitioner: Partitioners.DefaultPartitioner });
      const admin = client.admin();
      await Promise.all([producer.connect(), admin.connect()]);
      this.#kafka = producer;
      this.#kafkaAdmin = admin;
      this.#markUp("kafka");
    } catch (error) { this.#markDown("kafka", error); }
  }

  async #connectRedis(): Promise<void> {
    if (!this.#config.redisUrl) return;
    try {
      const client = createClient({ url: this.#config.redisUrl, socket: { connectTimeout: 2_000,
        reconnectStrategy: (retries) => Math.min(1_000, 50 * (retries + 1)) } });
      client.on("error", (error) => this.#markDown("redis", error));
      await client.connect();
      await client.ping();
      this.#redis = client as RedisClientType;
      this.#markUp("redis");
    } catch (error) { this.#markDown("redis", error); }
  }

  async #connectEtcd(regionId: string): Promise<void> {
    if (!this.#config.etcdHosts.length) return;
    try {
      const client = new Etcd3({ hosts: this.#config.etcdHosts, dialTimeout: 2_000 });
      this.#etcd = client;
      this.#etcdRegistrationKey = `/emergency/regions/${regionId}/runtime/${hostname()}`;
      await this.#registerOwnership(regionId);
      this.#markUp("etcd");
    } catch (error) { this.#markDown("etcd", error); }
  }

  async #probe(regionId: string): Promise<void> {
    if (this.#probing) return;
    this.#probing = true;
    try {
      const probes: Promise<unknown>[] = [];
      if (this.#postgres) probes.push(this.#postgres.query("SELECT 1")
        .then(() => this.#markUp("postgres")).catch((error: unknown) => this.#markDown("postgres", error)));
      if (this.#kafkaAdmin) probes.push(this.#kafkaAdmin.listTopics()
        .then(() => this.#markUp("kafka")).catch((error: unknown) => this.#markDown("kafka", error)));
      if (this.#redis) probes.push(this.#redis.ping()
        .then(() => this.#markUp("redis")).catch((error: unknown) => this.#markDown("redis", error)));
      if (this.#etcd && this.#etcdRegistrationKey) probes.push(this.#etcd.get(this.#etcdRegistrationKey).string()
        .then(async (value) => {
          if (!value) await this.#registerOwnership(regionId);
          this.#markUp("etcd");
        }).catch((error: unknown) => this.#markDown("etcd", error)));
      await Promise.allSettled(probes);
    } finally {
      this.#probing = false;
    }
  }

  async #registerOwnership(regionId: string): Promise<void> {
    if (!this.#etcd || !this.#etcdRegistrationKey) return;
    this.#etcdLease?.release();
    const lease = this.#etcd.lease(15);
    lease.on("lost", (error) => this.#markDown("etcd", error));
    await lease.put(this.#etcdRegistrationKey).value(JSON.stringify({
      regionId, role: "regional-api", state: "ACTIVE", registeredAt: new Date().toISOString(),
    }));
    this.#etcdLease = lease;
  }

  #markUp(name: IntegrationName): void {
    const current = this.#statuses.get(name)!;
    this.#statuses.set(name, { name: current.name, label: current.label, purpose: current.purpose,
      critical: current.critical, state: "UP" });
  }

  #markDown(name: IntegrationName, error: unknown): void {
    const current = this.#statuses.get(name)!;
    this.#statuses.set(name, { ...current, state: "DOWN", lastError: safeError(error) });
  }
}

function status(name: IntegrationName, label: string, purpose: string, critical: boolean, state: IntegrationState): IntegrationStatus {
  return { name, label, purpose, critical, state };
}

function criticalEvent(event: EventEnvelope): boolean {
  const payload = event.payload as { priority?: string } | undefined;
  return event.type.startsWith("Assignment") || event.type.startsWith("Incident") || ["P0", "P1"].includes(payload?.priority ?? "");
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\b(?:postgres(?:ql)?:\/\/)[^\s]+/gi, "[database-endpoint]").slice(0, 180);
}
