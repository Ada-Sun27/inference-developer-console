const RETRYABLE_PG_CODES = new Set([
  "40P01", // deadlock_detected
  "40001", // serialization_failure
]);

/** Retry a whole transaction on transient Postgres conflicts, with jittered backoff. */
export async function withPgRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (attempt >= attempts || !code || !RETRYABLE_PG_CODES.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 30));
    }
  }
}
