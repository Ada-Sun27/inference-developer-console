/**
 * Ingestion + aggregation against a real Postgres.
 * Run with a disposable database:  DATABASE_URL=postgres://... npm test
 * Skipped when DATABASE_URL is not set.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAggregationOnce } from "../src/server/aggregator";
import { ingestEvents, type IngestPrincipal } from "../src/server/ingest";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("ingestion and aggregation pipeline", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
    await pool.query(readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8"));
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** Each test gets its own tenant, so tests never see each other's data. */
  async function newPrincipal(): Promise<IngestPrincipal> {
    const tenantId = randomUUID();
    await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'test')`, [tenantId]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO projects (tenant_id, name) VALUES ($1, 'p') RETURNING id`,
      [tenantId],
    );
    return { tenantId, projectId: rows[0].id, apiKeyId: randomUUID() };
  }

  async function drain() {
    while ((await runAggregationOnce(pool)).buckets > 0) {
      /* keep going until the queue is empty */
    }
  }

  const minutesAgo = (m: number, extraSeconds = 0) => new Date(Date.now() - m * 60_000 + extraSeconds * 1000).toISOString();

  const event = (overrides: Record<string, unknown> = {}) => ({
    requestId: `req_${randomUUID()}`,
    model: "llama-3.3-70b",
    status: "success",
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 200,
    startedAt: minutesAgo(5),
    ...overrides,
  });

  /** Totals from rollups and from raw events must agree exactly. */
  async function expectRollupsMatchRaw(tenantId: string) {
    const rollup = await pool.query(
      `SELECT bucket_start, model, request_count::bigint AS n, error_count::bigint AS errors,
              input_tokens AS input, output_tokens AS output, cost_micros AS cost, latency_sum_ms AS latency
       FROM metrics_minute WHERE tenant_id = $1 ORDER BY 1, 2`,
      [tenantId],
    );
    const raw = await pool.query(
      `SELECT date_trunc('minute', started_at) AS bucket_start, model, count(*) AS n,
              count(*) FILTER (WHERE status = 'error') AS errors,
              sum(input_tokens) AS input, sum(output_tokens) AS output,
              sum(cost_micros) AS cost, sum(latency_ms) AS latency
       FROM request_events WHERE tenant_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
      [tenantId],
    );
    expect(rollup.rows.length).toBe(raw.rows.length);
    expect(JSON.stringify(rollup.rows)).toBe(JSON.stringify(raw.rows));
  }

  it("counts a retried event once", async () => {
    const p = await newPrincipal();
    const e = event();
    const first = await ingestEvents(pool, p, [e, e]); // duplicate inside one batch
    const retry = await ingestEvents(pool, p, [e]); // client retry
    expect(first).toMatchObject({ accepted: 1, duplicates: 1 });
    expect(retry).toMatchObject({ accepted: 0, duplicates: 1 });

    await drain();
    const { rows } = await pool.query(`SELECT sum(request_count)::int AS n FROM metrics_minute WHERE tenant_id = $1`, [p.tenantId]);
    expect(rows[0].n).toBe(1);
  });

  it("stores one row when the same event is submitted concurrently", async () => {
    const p = await newPrincipal();
    const e = event();
    const results = await Promise.all(Array.from({ length: 50 }, () => ingestEvents(pool, p, [e])));
    expect(results.reduce((sum, r) => sum + r.accepted, 0)).toBe(1);
    expect(results.reduce((sum, r) => sum + r.duplicates, 0)).toBe(49);
  });

  it("recomputes the original bucket when an event arrives late", async () => {
    const p = await newPrincipal();
    const startedAt = minutesAgo(30);
    await ingestEvents(pool, p, [event({ startedAt })]);
    await drain();

    // Same minute, arriving after that bucket was already aggregated.
    await ingestEvents(pool, p, [event({ startedAt: new Date(Date.parse(startedAt) + 1).toISOString() })]);
    // An event from three days ago.
    await ingestEvents(pool, p, [event({ startedAt: minutesAgo(3 * 24 * 60) })]);
    await drain();

    const { rows } = await pool.query(
      `SELECT request_count FROM metrics_minute WHERE tenant_id = $1 AND bucket_start = date_trunc('minute', $2::timestamptz)`,
      [p.tenantId, startedAt],
    );
    expect(rows[0].request_count).toBe(2);
    await expectRollupsMatchRaw(p.tenantId);
  });

  it("counts failed requests in the error rate", async () => {
    const p = await newPrincipal();
    const startedAt = minutesAgo(10);
    await ingestEvents(pool, p, [
      event({ startedAt }),
      event({ startedAt }),
      event({ startedAt }),
      event({ startedAt, status: "error", errorCode: "rate_limited", inputTokens: 0, outputTokens: 0 }),
    ]);
    await drain();
    const { rows } = await pool.query(
      `SELECT sum(request_count)::int AS n, sum(error_count)::int AS errors FROM metrics_minute WHERE tenant_id = $1`,
      [p.tenantId],
    );
    expect(rows[0]).toEqual({ n: 4, errors: 1 });
  });

  it("keeps rollups equal to raw events under concurrent ingestion and aggregation", async () => {
    const p = await newPrincipal();
    const sharedIds = Array.from({ length: 40 }, () => `req_${randomUUID()}`);
    const makeBatch = () =>
      Array.from({ length: 50 }, (_, i) =>
        event({
          // ~10% of events reuse IDs that other batches also send, i.e. racing retries.
          requestId: i % 10 === 0 ? sharedIds[Math.floor(Math.random() * sharedIds.length)] : `req_${randomUUID()}`,
          model: i % 2 ? "llama-3.3-70b" : "qwen-3-32b",
          status: Math.random() < 0.05 ? "error" : "success",
          inputTokens: Math.floor(Math.random() * 1000),
          latencyMs: Math.floor(Math.random() * 900),
          startedAt: minutesAgo(Math.floor(Math.random() * 20), Math.random() * 59),
        }),
      );

    let ingesting = true;
    const aggregator = (async () => {
      while (ingesting) await runAggregationOnce(pool, 25);
    })();

    await Promise.all(Array.from({ length: 20 }, () => ingestEvents(pool, p, makeBatch())));
    ingesting = false;
    await aggregator;
    await drain();

    await expectRollupsMatchRaw(p.tenantId);
  });
});
