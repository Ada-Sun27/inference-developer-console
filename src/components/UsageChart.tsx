"use client";

import { formatNumber, formatUsd } from "../lib/format";
import type { Interval, UsagePoint } from "../lib/series";

const W = 960;
const H = 240;
const PAD = { top: 8, right: 8, bottom: 28, left: 44 };

function label(iso: string, interval: Interval) {
  const d = new Date(iso);
  if (interval === "DAY") return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: interval === "MINUTE" ? "2-digit" : undefined });
}

function niceMax(value: number) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((s) => s * magnitude >= value) ?? 10;
  return step * magnitude;
}

/** Requests per interval as stacked bars: successful requests, with errors stacked on top. */
export function UsageChart({ points, interval }: { points: UsagePoint[]; interval: Interval }) {
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(0, ...points.map((p) => p.requestCount)));
  const slot = points.length ? innerW / points.length : innerW;
  const barW = Math.max(1, slot * 0.72);
  const y = (v: number) => (v / max) * innerH;
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Requests over time, split into successful and failed requests">
      {[0, 0.5, 1].map((f) => {
        const gy = PAD.top + innerH - f * innerH;
        return (
          <g key={f}>
            <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={gy} y2={gy} />
            <text className="axis" x={PAD.left - 8} y={gy + 4} textAnchor="end">
              {formatNumber(max * f)}
            </text>
          </g>
        );
      })}
      {points.map((p, i) => {
        const x = PAD.left + i * slot + (slot - barW) / 2;
        const okH = y(p.requestCount - p.errorCount);
        const errH = y(p.errorCount);
        const base = PAD.top + innerH;
        return (
          <g key={p.t}>
            <rect className="hit" x={PAD.left + i * slot} y={PAD.top} width={slot} height={innerH}>
              <title>
                {`${label(p.t, interval)}\n${formatNumber(p.requestCount)} requests, ${formatNumber(p.errorCount)} failed\n${formatNumber(p.tokens)} tokens, ${formatUsd(p.estimatedCostUsd)}`}
              </title>
            </rect>
            <rect className="bar-ok" x={x} y={base - okH} width={barW} height={okH} pointerEvents="none" />
            {errH > 0 && <rect className="bar-err" x={x} y={base - okH - errH} width={barW} height={errH} pointerEvents="none" />}
            {i % labelEvery === 0 && (
              <text className="axis" x={PAD.left + i * slot + slot / 2} y={H - 8} textAnchor="middle">
                {label(p.t, interval)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
