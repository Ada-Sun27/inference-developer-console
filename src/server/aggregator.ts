import type { Pool } from "pg";

export type AggregationResult = { buckets: number; tenantIds: string[] };

/**
 * Claim a batch of dirty minute buckets and recompute them from raw events.
 *
 * Recomputing a whole bucket (instead of incrementing counters) makes this idempotent
 * and correct for late and duplicate events: running it twice yields the same rows.
 *
 * Concurrency:
 * - FOR UPDATE SKIP LOCKED lets several workers split the queue without blocking.
 * - Ingestion marks buckets with a locking upsert. If an ingest transaction holds a
 *   bucket's mark, workers skip that bucket until the events commit. If a worker holds
 *   it, ingestion waits, then re-inserts the mark after the worker's delete commits,
 *   so the bucket is recomputed again. Either way, no committed event is left unaggregated.
 */
export async function runAggregationOnce(pool: Pool, batchSize = 200): Promise<AggregationResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<{ tenant_id: string; project_id: string; bucket_start: Date }>(
      `DELETE FROM dirty_buckets
       WHERE (tenant_id, project_id, bucket_start) IN (
         SELECT tenant_id, project_id, bucket_start
         FROM dirty_buckets
         ORDER BY marked_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING tenant_id, project_id, bucket_start`,
      [batchSize],
    );

    if (claimed.rows.length === 0) {
      await client.query("COMMIT");
      return { buckets: 0, tenantIds: [] };
    }

    const params = [
      claimed.rows.map((r) => r.tenant_id),
      claimed.rows.map((r) => r.project_id),
      claimed.rows.map((r) => r.bucket_start),
    ];

    await client.query(
      `DELETE FROM metrics_minute m
       USING unnest($1::uuid[], $2::uuid[], $3::timestamptz[]) AS c(tenant_id, project_id, bucket_start)
       WHERE m.tenant_id = c.tenant_id AND m.project_id = c.project_id AND m.bucket_start = c.bucket_start`,
      params,
    );

    await client.query(
      `INSERT INTO metrics_minute
         (tenant_id, project_id, model, bucket_start, request_count, error_count,
          input_tokens, output_tokens, cost_micros, latency_sum_ms, latency_max_ms, computed_at)
       SELECT e.tenant_id, e.project_id, e.model, c.bucket_start,
              count(*),
              count(*) FILTER (WHERE e.status = 'error'),
              sum(e.input_tokens), sum(e.output_tokens), sum(e.cost_micros),
              sum(e.latency_ms), max(e.latency_ms), now()
       FROM unnest($1::uuid[], $2::uuid[], $3::timestamptz[]) AS c(tenant_id, project_id, bucket_start)
       JOIN request_events e
         ON e.tenant_id = c.tenant_id
        AND e.project_id = c.project_id
        AND e.started_at >= c.bucket_start
        AND e.started_at <  c.bucket_start + interval '1 minute'
       GROUP BY e.tenant_id, e.project_id, e.model, c.bucket_start`,
      params,
    );

    await client.query("COMMIT");
    return {
      buckets: claimed.rows.length,
      tenantIds: [...new Set(claimed.rows.map((r) => r.tenant_id))],
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
