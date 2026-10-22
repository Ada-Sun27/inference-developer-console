"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useProjects } from "../../components/useProjects";
import { formatMs, formatNumber, formatTime, formatUsd } from "../../lib/format";
import { gql } from "../../lib/gql";

type InferenceRequest = {
  id: string;
  requestId: string;
  projectId: string;
  model: string;
  status: "SUCCESS" | "ERROR";
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  startedAt: string;
  receivedAt: string;
};

type Page = { edges: { cursor: string; node: InferenceRequest }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

const QUERY = `
  query Requests($filter: RequestFilter, $after: String) {
    requests(filter: $filter, first: 50, after: $after) {
      edges { cursor node { id requestId projectId model status errorCode inputTokens outputTokens estimatedCostUsd latencyMs startedAt receivedAt } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** An event counts as late if it reached the console more than a minute after it ran. */
const isLate = (r: InferenceRequest) => Date.parse(r.receivedAt) - Date.parse(r.startedAt) > 60_000;

export default function RequestsPage() {
  const projects = useProjects();
  const [models, setModels] = useState<string[]>([]);
  const [filter, setFilter] = useState({ projectId: "", model: "", status: "" });
  const [rows, setRows] = useState<InferenceRequest[]>([]);
  const [pageInfo, setPageInfo] = useState<Page["pageInfo"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    gql<{ models: string[] }>(`{ models }`).then((d) => setModels(d.models)).catch(() => {});
  }, []);

  const load = useCallback(
    async (after: string | null) => {
      setLoading(true);
      try {
        const variables = {
          after,
          filter: {
            projectId: filter.projectId || null,
            model: filter.model || null,
            status: filter.status || null,
          },
        };
        const d = await gql<{ requests: Page }>(QUERY, variables);
        const nodes = d.requests.edges.map((e) => e.node);
        setRows((prev) => (after ? [...prev, ...nodes] : nodes));
        setPageInfo(d.requests.pageInfo);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [filter],
  );

  // Filters change the result set, so start over from the first page.
  useEffect(() => {
    setOpenId(null);
    load(null);
  }, [load]);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const set = (key: keyof typeof filter) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilter((f) => ({ ...f, [key]: e.target.value }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Requests</h1>
          <p className="lede">Every inference request, newest first. Select a row for details.</p>
        </div>
        <div className="controls">
          <select aria-label="Project" value={filter.projectId} onChange={set("projectId")}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select aria-label="Model" value={filter.model} onChange={set("model")}>
            <option value="">All models</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select aria-label="Status" value={filter.status} onChange={set("status")}>
            <option value="">Any status</option>
            <option value="SUCCESS">Succeeded</option>
            <option value="ERROR">Failed</option>
          </select>
        </div>
      </div>

      {error && <div className="notice error">Couldn’t load requests: {error}</div>}

      {!error && rows.length === 0 && !loading && (
        <div className="notice">No requests match these filters. Clear a filter, or send traffic with an API key.</div>
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Request ID</th>
                <th>Model</th>
                <th>Status</th>
                <th className="num">Tokens in / out</th>
                <th className="num">Latency</th>
                <th className="num">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr
                    className="row"
                    tabIndex={0}
                    aria-expanded={openId === r.id}
                    onClick={() => setOpenId(openId === r.id ? null : r.id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpenId(openId === r.id ? null : r.id))}
                  >
                    <td>{formatTime(r.startedAt)}{isLate(r) && <span className="late">late</span>}</td>
                    <td className="mono">{r.requestId}</td>
                    <td>{r.model}</td>
                    <td><span className={r.status === "ERROR" ? "status error" : "status"}>{r.status === "ERROR" ? "Failed" : "Succeeded"}</span></td>
                    <td className="num">{formatNumber(r.inputTokens)} / {formatNumber(r.outputTokens)}</td>
                    <td className="num">{formatMs(r.latencyMs)}</td>
                    <td className="num">{formatUsd(r.estimatedCostUsd)}</td>
                  </tr>
                  {openId === r.id && (
                    <tr className="detail">
                      <td colSpan={7}>
                        <dl>
                          <dt>Project</dt><dd>{projectName(r.projectId)}</dd>
                          <dt>Started</dt><dd>{new Date(r.startedAt).toISOString()}</dd>
                          <dt>Received</dt><dd>{new Date(r.receivedAt).toISOString()}{isLate(r) && " (arrived after the request ran; counted in its original time bucket)"}</dd>
                          {r.errorCode && (<><dt>Error code</dt><dd className="mono">{r.errorCode}</dd></>)}
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pageInfo?.hasNextPage && (
        <div className="more">
          <button type="button" disabled={loading} onClick={() => load(pageInfo.endCursor)}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}
