import Redis from "ioredis";

const globalForRedis = globalThis as unknown as { __redis?: Redis };

export const redis =
  globalForRedis.__redis ??
  new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });

// The cache is optional: log Redis errors instead of crashing the process.
redis.on("error", (err) => console.warn("[redis]", err.message));

if (process.env.NODE_ENV !== "production") globalForRedis.__redis = redis;
