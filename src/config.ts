export type AppConfig = {
  port: number;
  host: string;
  regionId: string;
  databasePath: string;
  apiToken: string;
  commandSigningKey: string;
  edgeSpoolKeyHex?: string;
  p0QueueCapacity: number;
  generalQueueCapacity: number;
  autoAllocate: boolean;
  productionIntegrations: {
    postgresUrl?: string;
    kafkaBrokers: string[];
    redisUrl?: string;
    etcdHosts: string[];
  };
  optimizer: {
    url?: string;
    sharedSecret?: string;
    deadlineMs: number;
  };
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: positiveInteger(env.PORT, 8181),
    host: env.HOST || "127.0.0.1",
    regionId: env.REGION_ID || "region-a",
    databasePath: env.DATABASE_PATH || "./data/emergency.db",
    apiToken: env.EMERGENCY_API_TOKEN || "development-only-token",
    commandSigningKey: env.COMMAND_SIGNING_KEY || "development-signing-key-change-before-production",
    ...(env.EDGE_SPOOL_KEY_HEX ? { edgeSpoolKeyHex: env.EDGE_SPOOL_KEY_HEX } : {}),
    p0QueueCapacity: positiveInteger(env.P0_QUEUE_CAPACITY, 1_024),
    generalQueueCapacity: positiveInteger(env.GENERAL_QUEUE_CAPACITY, 4_096),
    autoAllocate: env.AUTO_ALLOCATE !== "false",
    productionIntegrations: {
      ...(env.POSTGRES_URL ? { postgresUrl: env.POSTGRES_URL } : {}),
      kafkaBrokers: env.KAFKA_BROKERS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
      ...(env.REDIS_URL ? { redisUrl: env.REDIS_URL } : {}),
      etcdHosts: env.ETCD_ENDPOINTS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
    },
    optimizer: {
      ...(env.OPTIMIZER_URL ? { url: env.OPTIMIZER_URL } : {}),
      ...(env.OPTIMIZER_SHARED_SECRET ? { sharedSecret: env.OPTIMIZER_SHARED_SECRET } : {}),
      deadlineMs: positiveInteger(env.OPTIMIZER_DEADLINE_MS, 40),
    },
  };
}
