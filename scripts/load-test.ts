/**
 * Concurrent ingestion load test.
 *   npm run loadtest -- <apiKey> [totalEvents=20000] [concurrency=16] [batchSize=100]
 *
 * About 10% of events reuse an earlier request ID, simulating client retries, so the
 * report should show those as duplicates rather than accepted events.
 */
import { randomUUID } from "node:crypto";
import { MODELS } from "../src/lib/pricing";

const [apiKey, totalArg = "20000", concurrencyArg = "16", batchArg = "100"] = process.argv.slice(2);
if (!apiKey) {
  console.error("Usage: npm run loadtest -- <apiKey> [totalEvents] [concurrency] [batchSize]");
  process.exit(1);
}
const URL = process.env.INGEST_URL ?? "http://localhost:3000/api/ingest";
const total = Number(totalArg);
const concurrency = Number(concurrencyArg);
const batchSize = Number(batchArg);

const seenIds: string[] = [];
function makeEvent() {
  const retry = seenIds.length > 0 && Math.random() < 0.1;
  const requestId = retry ? seenIds[Math.floor(Math.random() * seenIds.length)] : `load_${randomUUID()}`;
  if (!retry) seenIds.push(requestId);
  return {
    requestId,
    model: MODELS[Math.floor(Math.random() * MODELS.length)],
    status: Math.random() < 0.02 ? "error" : "success",
    inputTokens: Math.round(Math.random() * 2_000),
    outputTokens: Math.round(Math.random() * 800),
    latencyMs: Math.round(50 + Math.random() * 900),
    startedAt: new Date(Date.now() - Math.random() * 120_000).toISOString(),
  };
}

async function main() {
  const batches = Math.ceil(total / batchSize);
  let next = 0;
  const totals = { accepted: 0, duplicates: 0, rejected: 0, failedBatches: 0 };
  const latencies: number[] = [];

  async function workerLoop() {
    while (next < batches) {
      next++;
      const events = Array.from({ length: batchSize }, makeEvent);
      const t0 = performance.now();
      const res = await fetch(URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ events }),
      });
      latencies.push(performance.now() - t0);
      if (!res.ok) {
        totals.failedBatches++;
        continue;
      }
      const body = (await res.json()) as { accepted: number; duplicates: number; rejected: unknown[] };
      totals.accepted += body.accepted;
      totals.duplicates += body.duplicates;
      totals.rejected += body.rejected.length;
    }
  }

  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, workerLoop));
  const seconds = (performance.now() - start) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))].toFixed(1);

  console.log(`Sent ${batches * batchSize} events in ${seconds.toFixed(1)} s (${Math.round((batches * batchSize) / seconds)} events/s)`);
  console.log(`Accepted ${totals.accepted}, duplicates ${totals.duplicates}, rejected ${totals.rejected}, failed batches ${totals.failedBatches}`);
  console.log(`Batch latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, p99 ${pct(0.99)} ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
