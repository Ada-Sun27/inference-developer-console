export type Interval = "MINUTE" | "HOUR" | "DAY";

export type UsagePoint = {
  t: string;
  requestCount: number;
  errorCount: number;
  tokens: number;
  estimatedCostUsd: number;
  avgLatencyMs: number | null;
};

export const INTERVAL_MS: Record<Interval, number> = {
  MINUTE: 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000,
};

/** Fill empty buckets with zeros so the chart shows gaps as gaps, not as missing bars. */
export function fillSeries(points: UsagePoint[], from: string, to: string, interval: Interval): UsagePoint[] {
  const step = INTERVAL_MS[interval];
  const byTime = new Map(points.map((p) => [new Date(p.t).getTime(), p]));
  const start = Math.floor(new Date(from).getTime() / step) * step;
  const end = new Date(to).getTime();
  const out: UsagePoint[] = [];
  for (let t = start; t < end; t += step) {
    out.push(
      byTime.get(t) ?? { t: new Date(t).toISOString(), requestCount: 0, errorCount: 0, tokens: 0, estimatedCostUsd: 0, avgLatencyMs: null },
    );
  }
  return out;
}
