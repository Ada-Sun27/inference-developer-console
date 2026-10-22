import { createHash } from "node:crypto";
import type Redis from "ioredis";

/**
 * Versioned cache for aggregate queries.
 *
 * Every key embeds the tenant's metrics version. When the aggregator recomputes any
 * bucket for a tenant it bumps the version, so all of that tenant's cached aggregates
 * become unreachable at once, with no need to find and delete individual keys.
 * Old entries expire through their TTL.
 *
 * Redis is an optimization, not a dependency: on any Redis error we fall back to Postgres.
 */
const versionKey = (tenantId: string) => `metrics:ver:${tenantId}`;

export async function cached<T>(
  redis: Redis,
  tenantId: string,
  name: string,
  args: unknown,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  let key: string | null = null;
  try {
    const version = (await redis.get(versionKey(tenantId))) ?? "0";
    const digest = createHash("sha1").update(JSON.stringify(args)).digest("hex");
    key = `metrics:${tenantId}:v${version}:${name}:${digest}`;
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    key = null;
  }

  const value = await load();
  if (key) redis.set(key, JSON.stringify(value), "EX", ttlSeconds).catch(() => {});
  return value;
}

export async function bumpMetricsVersion(redis: Redis, tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) return;
  const pipeline = redis.pipeline();
  for (const id of tenantIds) pipeline.incr(versionKey(id));
  await pipeline.exec();
}
