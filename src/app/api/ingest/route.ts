import { pool } from "../../../lib/db";
import { authenticateApiKey, ingestEvents, MAX_BATCH } from "../../../server/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status: number) => Response.json(body, { status });

/**
 * POST /api/ingest
 * Authorization: Bearer <api key>
 * Body: one event, or { "events": [...] } with up to 500 events.
 *
 * Writes only raw events and bucket marks; aggregation happens in the background worker,
 * so ingestion latency doesn't grow with dashboard query cost.
 */
export async function POST(request: Request) {
  const header = request.headers.get("authorization");
  const secret = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!secret) return json({ error: "Missing API key. Send it as 'Authorization: Bearer <key>'." }, 401);

  const principal = await authenticateApiKey(pool, secret);
  if (!principal) return json({ error: "API key is invalid or has been revoked." }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const events =
    typeof body === "object" && body !== null && Array.isArray((body as { events?: unknown }).events)
      ? ((body as { events: unknown[] }).events)
      : [body];
  if (events.length > MAX_BATCH) return json({ error: `A batch can contain at most ${MAX_BATCH} events.` }, 413);

  const result = await ingestEvents(pool, principal, events);
  const nothingStored = result.accepted === 0 && result.duplicates === 0;
  return json(result, nothingStored && result.rejected.length > 0 ? 400 : 200);
}
