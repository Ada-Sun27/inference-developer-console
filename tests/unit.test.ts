import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/lib/cursor";
import { estimateCostMicros } from "../src/lib/pricing";
import { fillSeries } from "../src/lib/series";
import { MAX_LATE_MS, validateEvent } from "../src/server/validate";

const now = new Date("2026-09-15T12:00:00.000Z");
const base = {
  requestId: "req_1",
  model: "llama-3.3-70b",
  status: "success",
  inputTokens: 1000,
  outputTokens: 500,
  latencyMs: 320,
  startedAt: "2026-09-15T11:59:00.000Z",
};

describe("cursor", () => {
  it("round-trips", () => {
    const c = { startedAt: "2026-09-15T11:59:00.123Z", id: "42" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("rejects tampered input", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow("Invalid cursor");
    const badId = Buffer.from(JSON.stringify(["2026-09-15T00:00:00Z", "1; DROP TABLE"])).toString("base64url");
    expect(() => decodeCursor(badId)).toThrow("Invalid cursor");
  });
});

describe("pricing", () => {
  it("returns integer micro-dollars", () => {
    // 1000 * 0.85 + 500 * 1.2 = 1450 micro-USD
    expect(estimateCostMicros("llama-3.3-70b", 1000, 500)).toBe(1450);
    expect(Number.isInteger(estimateCostMicros("qwen-3-32b", 333, 777))).toBe(true);
  });
});

describe("validateEvent", () => {
  it("accepts a valid event and computes its cost", () => {
    const r = validateEvent(base, now);
    expect(r.ok && r.event.costMicros).toBe(1450);
  });

  it("truncates timestamps to milliseconds", () => {
    const r = validateEvent({ ...base, startedAt: "2026-09-15T11:59:00.123456Z" }, now);
    expect(r.ok && r.event.startedAt).toBe("2026-09-15T11:59:00.123Z");
  });

  it("accepts late events inside the window and rejects ones outside it", () => {
    const late = new Date(now.getTime() - MAX_LATE_MS + 60_000).toISOString();
    const tooLate = new Date(now.getTime() - MAX_LATE_MS - 60_000).toISOString();
    expect(validateEvent({ ...base, startedAt: late }, now).ok).toBe(true);
    expect(validateEvent({ ...base, startedAt: tooLate }, now).ok).toBe(false);
  });

  it("rejects future timestamps beyond clock skew", () => {
    expect(validateEvent({ ...base, startedAt: "2026-09-15T12:30:00Z" }, now).ok).toBe(false);
  });

  it("rejects unknown models and negative tokens", () => {
    expect(validateEvent({ ...base, model: "made-up" }, now).ok).toBe(false);
    expect(validateEvent({ ...base, inputTokens: -1 }, now).ok).toBe(false);
    expect(validateEvent({ ...base, latencyMs: 1.5 }, now).ok).toBe(false);
  });

  it("defaults an error code for failed requests", () => {
    const r = validateEvent({ ...base, status: "error" }, now);
    expect(r.ok && r.event.errorCode).toBe("unknown");
  });
});

describe("fillSeries", () => {
  it("fills missing buckets with zeros", () => {
    const points = [{ t: "2026-09-15T01:00:00.000Z", requestCount: 5, errorCount: 1, tokens: 10, estimatedCostUsd: 0.01, avgLatencyMs: 100 }];
    const filled = fillSeries(points, "2026-09-15T00:00:00.000Z", "2026-09-15T03:00:00.000Z", "HOUR");
    expect(filled.map((p) => p.requestCount)).toEqual([0, 5, 0]);
  });
});
