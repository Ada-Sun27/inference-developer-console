import "dotenv/config";
import { pool } from "../lib/db";
import { redis } from "../lib/redis";
import { runAggregationOnce } from "../server/aggregator";
import { bumpMetricsVersion } from "../server/cache";

const BATCH_SIZE = 200;
const POLL_MS = Number(process.env.AGGREGATOR_POLL_MS ?? 1000);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[worker] ${signal} received, finishing current batch`);
    stopping = true;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("[worker] aggregator started");
  while (!stopping) {
    try {
      const result = await runAggregationOnce(pool, BATCH_SIZE);
      if (result.buckets > 0) {
        await bumpMetricsVersion(redis, result.tenantIds).catch((err) =>
          console.warn("[worker] cache version bump failed; entries expire by TTL", err.message),
        );
        console.log(`[worker] recomputed ${result.buckets} buckets`);
      }
      // A full batch means there is a backlog: keep draining without sleeping.
      if (result.buckets < BATCH_SIZE) await sleep(POLL_MS);
    } catch (err) {
      console.error("[worker] aggregation failed, backing off", err);
      await sleep(POLL_MS * 5);
    }
  }
  await pool.end();
  redis.disconnect();
}

main();
