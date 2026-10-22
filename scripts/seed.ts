import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { MODELS } from "../src/lib/pricing";
import { runAggregationOnce } from "../src/server/aggregator";
import { generateApiKey } from "../src/server/apiKeys";
import { ingestEvents } from "../src/server/ingest";

const TENANT_ID = process.env.DEV_TENANT_ID ?? "00000000-0000-4000-8000-000000000001";
const DAYS = 7;
const EVENTS = 6_000;
const LATE_SHARE = 0.02;
const ERROR_CODES = ["rate_limited", "context_length_exceeded", "upstream_timeout", "invalid_request"];

const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];

/** Busier during working hours (UTC), quieter at night. */
function sampleStartedAt(now: number): Date {
  for (;;) {
    const t = now - Math.random() * DAYS * 86_400_000;
    const hour = new Date(t).getUTCHours();
    const weight = 0.25 + 0.75 * Math.max(0, Math.sin(((hour - 6) / 24) * 2 * Math.PI));
    if (Math.random() < weight) return new Date(t);
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Demo org') ON CONFLICT (id) DO NOTHING`, [TENANT_ID]);

  const projectIds: string[] = [];
  for (const name of ["chat-assistant", "batch-summarizer"]) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO projects (tenant_id, name) VALUES ($1, $2)
       ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [TENANT_ID, name],
    );
    projectIds.push(rows[0].id);
  }

  const key = generateApiKey();
  const { rows: keyRows } = await pool.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, project_id, name, prefix, key_hash) VALUES ($1, $2, 'Seed key', $3, $4) RETURNING id`,
    [TENANT_ID, projectIds[0], key.prefix, key.hash],
  );

  const now = Date.now();
  for (const [i, projectId] of projectIds.entries()) {
    const principal = { tenantId: TENANT_ID, projectId, apiKeyId: keyRows[0].id };
    const count = i === 0 ? Math.round(EVENTS * 0.7) : Math.round(EVENTS * 0.3);
    const events = Array.from({ length: count }, () => {
      const failed = Math.random() < 0.03;
      const inputTokens = Math.round(200 + Math.random() * 3_000);
      return {
        requestId: `${Math.random() < LATE_SHARE ? "late" : "req"}_${randomUUID()}`,
        model: pick(MODELS),
        status: failed ? "error" : "success",
        errorCode: failed ? pick(ERROR_CODES) : undefined,
        inputTokens: failed ? 0 : inputTokens,
        outputTokens: failed ? 0 : Math.round(50 + Math.random() * 1_200),
        latencyMs: Math.round(80 + Math.random() ** 3 * 2_500),
        startedAt: sampleStartedAt(now).toISOString(),
      };
    });
    for (let start = 0; start < events.length; start += 500) {
      await ingestEvents(pool, principal, events.slice(start, start + 500));
    }
  }

  // Seed-only: real events arrive moments after they run, so backdate received_at for
  // everything except the deliberately late events. Ingestion never does this.
  await pool.query(
    `UPDATE request_events
     SET received_at = started_at + random() * interval '2 seconds'
     WHERE tenant_id = $1 AND request_id LIKE 'req_%'`,
    [TENANT_ID],
  );

  let buckets = 0;
  for (;;) {
    const r = await runAggregationOnce(pool, 1_000);
    buckets += r.buckets;
    if (r.buckets === 0) break;
  }
  await pool.end();

  console.log(`Seeded ${EVENTS} events into ${buckets} minute buckets.`);
  console.log(`Tenant ID (DEV_TENANT_ID): ${TENANT_ID}`);
  console.log(`API key for "chat-assistant" (shown once): ${key.secret}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
