import type { Pool } from "pg";
import { hashApiKey } from "./apiKeys";
import { withPgRetry } from "./retry";
import { validateEvent, type ValidEvent } from "./validate";

export type IngestPrincipal = { tenantId: string; projectId: string; apiKeyId: string };

export type IngestResult = {
  accepted: number;
  duplicates: number;
  rejected: { index: number; error: string }[];
};

export const MAX_BATCH = 500;

export async function authenticateApiKey(pool: Pool, secret: string): Promise<IngestPrincipal | null> {
  const { rows } = await pool.query<{ id: string; tenant_id: string; project_id: string }>(
    `SELECT id, tenant_id, project_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hashApiKey(secret)],
  );
  const key = rows[0];
  if (!key) return null;

  // Record usage at most once a minute per key, off the request path,
  // so a busy key doesn't turn into a hot row that every request writes to.
  pool
    .query(
      `UPDATE api_keys SET last_used_at = now()
       WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [key.id],
    )
    .catch((err) => console.warn("[ingest] last_used_at update failed", err.message));

  return { tenantId: key.tenant_id, projectId: key.project_id, apiKeyId: key.id };
}

/**
 * Store request events and mark their minute buckets for re-aggregation.
 *
 * - Idempotent: (tenant_id, request_id) is unique, so retried or duplicated events are
 *   counted once. The first write wins.
 * - Late events are accepted (up to the late window) and simply re-dirty an old bucket.
 * - Events and bucket marks commit together, so an event can never be stored without
 *   its bucket eventually being recomputed.
 */
export async function ingestEvents(
  pool: Pool,
  principal: IngestPrincipal,
  inputs: unknown[],
  now: Date = new Date(),
): Promise<IngestResult> {
  const valid: ValidEvent[] = [];
  const rejected: IngestResult["rejected"] = [];
  inputs.forEach((input, index) => {
    const result = validateEvent(input, now);
    if (result.ok) valid.push(result.event);
    else rejected.push({ index, error: result.error });
  });
  if (valid.length === 0) return { accepted: 0, duplicates: 0, rejected };

  // Insert in a stable order so concurrent batches that share request IDs
  // acquire index locks in the same order instead of deadlocking.
  valid.sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));

  const accepted = await withPgRetry(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ started_at: Date }>(
        `INSERT INTO request_events
           (tenant_id, project_id, request_id, model, status, error_code,
            input_tokens, output_tokens, cost_micros, latency_ms, started_at)
         SELECT $1::uuid, $2::uuid, r.*
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[],
                     $7::int[], $8::int[], $9::bigint[], $10::int[], $11::timestamptz[])
           AS r(request_id, model, status, error_code,
                input_tokens, output_tokens, cost_micros, latency_ms, started_at)
         ON CONFLICT (tenant_id, request_id) DO NOTHING
         RETURNING started_at`,
        [
          principal.tenantId,
          principal.projectId,
          valid.map((v) => v.requestId),
          valid.map((v) => v.model),
          valid.map((v) => v.status),
          valid.map((v) => v.errorCode),
          valid.map((v) => v.inputTokens),
          valid.map((v) => v.outputTokens),
          valid.map((v) => v.costMicros),
          valid.map((v) => v.latencyMs),
          valid.map((v) => v.startedAt),
        ],
      );

      if (inserted.rows.length > 0) {
        await client.query(
          `INSERT INTO dirty_buckets (tenant_id, project_id, bucket_start)
           SELECT DISTINCT $1::uuid, $2::uuid, date_trunc('minute', t)
           FROM unnest($3::timestamptz[]) AS t
           ORDER BY 3
           -- A no-op update instead of DO NOTHING: it locks an existing mark, so a worker
           -- can't claim and recompute this bucket until our events are committed.
           -- Keep the original marked_at so a busy bucket isn't pushed to the back of the queue.
           ON CONFLICT (tenant_id, project_id, bucket_start)
           DO UPDATE SET marked_at = dirty_buckets.marked_at`,
          [principal.tenantId, principal.projectId, inserted.rows.map((r) => r.started_at)],
        );
      }
      await client.query("COMMIT");
      return inserted.rows.length;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  return { accepted, duplicates: valid.length - accepted, rejected };
}
