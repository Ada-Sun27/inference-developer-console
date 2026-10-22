"use client";

import { useEffect, useMemo, useState } from "react";
import { UsageChart } from "../components/UsageChart";
import { useProjects } from "../components/useProjects";
import { formatMs, formatNumber, formatPercent, formatUsd } from "../lib/format";
import { gql } from "../lib/gql";
import { fillSeries, type Interval, type UsagePoint } from "../lib/series";

const RANGES = {
  "24h": { label: "Last 24 hours", ms: 86_400_000, interval: "HOUR" as Interval },
  "7d": { label: "Last 7 days", ms: 7 * 86_400_000, interval: "HOUR" as Interval },
  "30d": { label: "Last 30 days", ms: 30 * 86_400_000, interval: "DAY" as Interval },
};
type RangeKey = keyof typeof RANGES;

type Summary = {
  requestCount: number;
  errorCount: number;
  errorRate: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
};

const QUERY = `
  query Usage($range: TimeRange!, $interval: Interval!, $projectId: ID) {
    usageSummary(range: $range, projectId: $projectId) {
      requestCount errorCount errorRate inputTokens outputTokens estimatedCostUsd avgLatencyMs p95LatencyMs
    }
    usageSeries(range: $range, interval: $interval, projectId: $projectId) {
      t requestCount errorCount tokens estimatedCostUsd avgLatencyMs
    }
  }
`;

export default function UsagePage() {
  const projects = useProjects();
  const [rangeKey, setRangeKey] = useState<RangeKey>("24h");
  const [projectId, setProjectId] = useState("");
  const [data, setData] = useState<{ summary: Summary; series: UsagePoint[]; from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const { ms, interval } = RANGES[rangeKey];
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    const range = { from: from.toISOString(), to: to.toISOString() };
    setLoading(true);
    gql<{ usageSummary: Summary; usageSeries: UsagePoint[] }>(QUERY, { range, interval, projectId: projectId || null })
      .then((d) => {
        if (cancelled) return;
        setData({ summary: d.usageSummary, series: d.usageSeries, ...range });
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [rangeKey, projectId]);

  const interval = RANGES[rangeKey].interval;
  const series = useMemo(
    () => (data ? fillSeries(data.series, data.from, data.to, interval) : []),
    [data, interval],
  );
  const s = data?.summary;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Usage</h1>
          <p className="lede">Requests, tokens, estimated cost, and latency across your projects. Figures refresh within a minute of new traffic.</p>
        </div>
        <div className="controls">
          <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <div className="segmented" role="group" aria-label="Time range">
            {(Object.keys(RANGES) as RangeKey[]).map((k) => (
              <button key={k} type="button" aria-pressed={k === rangeKey} onClick={() => setRangeKey(k)} title={RANGES[k].label}>
                {k}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <div className="notice error">Couldn’t load usage: {error}</div>}

      {s && (
        <dl className="figures" aria-busy={loading}>
          <div className="figure">
            <dt>Requests</dt>
            <dd>{formatNumber(s.requestCount)}</dd>
          </div>
          <div className="figure">
            <dt>Error rate</dt>
            <dd>{formatPercent(s.errorRate)}<small>{formatNumber(s.errorCount)} failed</small></dd>
          </div>
          <div className="figure">
            <dt>Tokens</dt>
            <dd>{formatNumber(s.inputTokens + s.outputTokens)}<small>{formatNumber(s.inputTokens)} in, {formatNumber(s.outputTokens)} out</small></dd>
          </div>
          <div className="figure">
            <dt>Estimated cost</dt>
            <dd>{formatUsd(s.estimatedCostUsd)}</dd>
          </div>
          <div className="figure">
            <dt>Latency</dt>
            <dd>{formatMs(s.p95LatencyMs)}<small>p95, average {formatMs(s.avgLatencyMs)}</small></dd>
          </div>
        </dl>
      )}

      {data && (
        <section className="chart">
          <div className="chart-head">
            <h2>Requests per {interval.toLowerCase()}</h2>
            <div className="legend"><span>Succeeded</span><span className="err">Failed</span></div>
          </div>
          {s && s.requestCount === 0 ? (
            <p className="muted">No requests in this range yet. Send traffic with an API key from the API keys page to see it here.</p>
          ) : (
            <UsageChart points={series} interval={interval} />
          )}
        </section>
      )}
    </>
  );
}
