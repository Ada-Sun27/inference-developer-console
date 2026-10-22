import { estimateCostMicros, isKnownModel, type ModelId } from "../lib/pricing";

/** Events may arrive late (retries, buffered gateways), but not indefinitely. */
export const MAX_LATE_MS = 7 * 24 * 60 * 60 * 1000;
/** Tolerate small clock skew between the gateway and this service. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type ValidEvent = {
  requestId: string;
  model: ModelId;
  status: "success" | "error";
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** ISO-8601, truncated to milliseconds so keyset cursors round-trip exactly. */
  startedAt: string;
  costMicros: number;
};

export type ValidationResult = { ok: true; event: ValidEvent } | { ok: false; error: string };

const fail = (error: string): ValidationResult => ({ ok: false, error });
const isNonNegativeInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

export function validateEvent(input: unknown, now: Date): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("event must be an object");
  const e = input as Record<string, unknown>;

  const requestId = e.requestId;
  if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128) {
    return fail("requestId must be a string of 1-128 characters");
  }

  const model = e.model;
  if (typeof model !== "string" || !isKnownModel(model)) return fail(`unknown model: ${String(model)}`);

  const status = e.status;
  if (status !== "success" && status !== "error") return fail("status must be 'success' or 'error'");

  const errorCode = e.errorCode;
  if (errorCode != null && typeof errorCode !== "string") return fail("errorCode must be a string");

  const { inputTokens, outputTokens, latencyMs } = e;
  if (!isNonNegativeInt(inputTokens)) return fail("inputTokens must be a non-negative integer");
  if (!isNonNegativeInt(outputTokens)) return fail("outputTokens must be a non-negative integer");
  if (!isNonNegativeInt(latencyMs)) return fail("latencyMs must be a non-negative integer");

  if (typeof e.startedAt !== "string") return fail("startedAt must be an ISO-8601 timestamp");
  const startedMs = Date.parse(e.startedAt);
  if (Number.isNaN(startedMs)) return fail("startedAt must be an ISO-8601 timestamp");
  if (startedMs > now.getTime() + MAX_CLOCK_SKEW_MS) return fail("startedAt is in the future");
  if (startedMs < now.getTime() - MAX_LATE_MS) return fail("startedAt is older than the 7-day late-arrival window");

  return {
    ok: true,
    event: {
      requestId,
      model,
      status,
      errorCode: status === "error" ? errorCode ?? "unknown" : null,
      inputTokens,
      outputTokens,
      latencyMs,
      startedAt: new Date(startedMs).toISOString(),
      costMicros: estimateCostMicros(model, inputTokens, outputTokens),
    },
  };
}
