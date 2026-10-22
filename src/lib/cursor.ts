/**
 * Opaque keyset cursor for request listings, ordered by (started_at DESC, id DESC).
 * started_at is stored at millisecond precision (see validate.ts), so it round-trips
 * through a JS Date without losing precision and skipping rows.
 */
export type RequestCursor = { startedAt: string; id: string };

export function encodeCursor(cursor: RequestCursor): string {
  return Buffer.from(JSON.stringify([cursor.startedAt, cursor.id]), "utf8").toString("base64url");
}

export function decodeCursor(value: string): RequestCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid cursor");
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error("Invalid cursor");
  const [startedAt, id] = parsed;
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) throw new Error("Invalid cursor");
  if (typeof id !== "string" || !/^\d+$/.test(id)) throw new Error("Invalid cursor");
  return { startedAt, id };
}
