import { GraphQLError } from "graphql";
import type Redis from "ioredis";
import type { Pool } from "pg";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { MODELS, microsToUsd } from "../lib/pricing";
import { INTERVAL_MS, type Interval } from "../lib/series";
import { generateApiKey } from "../server/apiKeys";
import { cached } from "../server/cache";

export type Context = { tenantId: string; pool: Pool; redis: Redis };

type TimeRange = { from: string; to: string };
type RequestFilter = {
  projectId?: string | null;
  model?: string | null;
  status?: "SUCCESS" | "ERROR" | null;
  from?: string | null;
  to?: string | null;
};

const MAX_RANGE_MS = 31 * 86_400_000;
const MAX_SERIES_POINTS = 2_000;
const AGGREGATE_TTL_SECONDS = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const badInput = (message: string) => new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
const notFound = (message: string) => new GraphQLError(message, { extensions: { code: "NOT_FOUND" } });

function assertUuid(value: string, field: string): string {
  if (!UUID_RE.test(value)) throw badInput(`${field} is not a valid ID`);
  return value;
}

function parseTimestamp(value: string, field: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw badInput(`${field} must be an ISO-8601 timestamp`);
  return new Date(ms).toISOString();
}

/**
 * Snap a range to whole minutes (the rollup granularity). This also makes cache keys
 * stable: every dashboard refresh within the same minute hits the same entry.
 */
function parseRange(range: TimeRange): TimeRange {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  if (Number.isNaN(from) || Number.isNaN(to)) throw badInput("range.from and range.to must be ISO-8601 timestamps");
  if (from >= to) throw badInput("range.from must be before range.to");
  if (to - from > MAX_RANGE_MS) throw badInput("range cannot exceed 31 days");
  const minute = 60_000;
  return {
    from: new Date(Math.floor(from / minute) * minute).toISOString(),
    to: new Date(Math.ceil(to / minute) * minute).toISOString(),
  };
}

/** Builds a parameterized, tenant-scoped WHERE clause. Every query starts from the tenant. */
class Where {
  readonly params: unknown[];
  private readonly clauses: string[];

  constructor(tenantId: string) {
    this.params = [tenantId];
    this.clauses = ["tenant_id = $1"];
  }

  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  and(clause: string): this {
    this.clauses.push(clause);
    return this;
  }

  toString(): string {
    return this.clauses.join(" AND ");
  }
}

function metricsWhere(ctx: Context, range: TimeRange, timeColumn: string, projectId?: string | null, model?: string | null) {
  const w = new Where(ctx.tenantId);
  w.and(`${timeColumn} >= ${w.param(range.from)}::timestamptz`);
  w.and(`${timeColumn} < ${w.param(range.to)}::timestamptz`);
  if (projectId) w.and(`project_id = ${w.param(assertUuid(projectId, "projectId"))}`);
  if (model) w.and(`model = ${w.param(model)}`);
  return w;
}

type RequestRow = {
  id: string;
  request_id: string;
  project_id: string;
  model: string;
  status: "success" | "error";
  error_code: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_micros: string;
  latency_ms: number;
  started_at: Date;
  received_at: Date;
};

type ApiKeyRow = {
  id: string;
  project_id: string;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

const API_KEY_COLUMNS = "id, project_id, name, prefix, created_at, last_used_at, revoked_at";

function toApiKey(r: ApiKeyRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
  };
}

const num = (v: string | number | null) => (v == null ? 0 : Number(v));

export const resolvers = {
  Query: {
    models: () => MODELS,

    projects: async (_: unknown, __: unknown, ctx: Context) => {
      const { rows } = await ctx.pool.query<{ id: string; name: string; created_at: Date }>(
        `SELECT id, name, created_at FROM projects WHERE tenant_id = $1 ORDER BY created_at`,
        [ctx.tenantId],
      );
      return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at.toISOString() }));
    },

    requests: async (_: unknown, args: { filter?: RequestFilter | null; first?: number | null; after?: string | null }, ctx: Context) => {
      const first = Math.min(Math.max(args.first ?? 25, 1), 100);
      const filter = args.filter ?? {};
      const w = new Where(ctx.tenantId);
      if (filter.projectId) w.and(`project_id = ${w.param(assertUuid(filter.projectId, "projectId"))}`);
      if (filter.model) w.and(`model = ${w.param(filter.model)}`);
      if (filter.status) w.and(`status = ${w.param(filter.status.toLowerCase())}`);
      if (filter.from) w.and(`started_at >= ${w.param(parseTimestamp(filter.from, "filter.from"))}::timestamptz`);
      if (filter.to) w.and(`started_at < ${w.param(parseTimestamp(filter.to, "filter.to"))}::timestamptz`);
      if (args.after) {
        let cursor;
        try {
          cursor = decodeCursor(args.after);
        } catch {
          throw badInput("Invalid cursor");
        }
        // Row-value comparison matches the (started_at DESC, id DESC) index order exactly.
        w.and(`(started_at, id) < (${w.param(cursor.startedAt)}::timestamptz, ${w.param(cursor.id)}::bigint)`);
      }
      const limit = w.param(first + 1); // fetch one extra row to learn whether another page exists

      const { rows } = await ctx.pool.query<RequestRow>(
        `SELECT id::text, request_id, project_id, model, status, error_code, input_tokens, output_tokens,
                cost_micros::text, latency_ms, started_at, received_at
         FROM request_events
         WHERE ${w}
         ORDER BY started_at DESC, id DESC
         LIMIT ${limit}`,
        w.params,
      );

      const page = rows.slice(0, first);
      const cursorOf = (r: RequestRow) => encodeCursor({ startedAt: r.started_at.toISOString(), id: r.id });
      return {
        edges: page.map((r) => ({
          cursor: cursorOf(r),
          node: {
            id: r.id,
            requestId: r.request_id,
            projectId: r.project_id,
            model: r.model,
            status: r.status.toUpperCase(),
            errorCode: r.error_code,
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            estimatedCostUsd: microsToUsd(Number(r.cost_micros)),
            latencyMs: r.latency_ms,
            startedAt: r.started_at.toISOString(),
            receivedAt: r.received_at.toISOString(),
          },
        })),
        pageInfo: {
          hasNextPage: rows.length > first,
          endCursor: page.length ? cursorOf(page[page.length - 1]) : null,
        },
      };
    },

    usageSummary: async (_: unknown, args: { range: TimeRange; projectId?: string | null; model?: string | null }, ctx: Context) => {
      const range = parseRange(args.range);
      const key = { range, projectId: args.projectId ?? null, model: args.model ?? null };

      return cached(ctx.redis, ctx.tenantId, "usageSummary", key, AGGREGATE_TTL_SECONDS, async () => {
        const m = metricsWhere(ctx, range, "bucket_start", args.projectId, args.model);
        const totalsQuery = ctx.pool.query<Record<string, string | null>>(
          `SELECT sum(request_count)  AS requests,
                  sum(error_count)    AS errors,
                  sum(input_tokens)   AS input_tokens,
                  sum(output_tokens)  AS output_tokens,
                  sum(cost_micros)    AS cost_micros,
                  sum(latency_sum_ms) AS latency_sum
           FROM metrics_minute WHERE ${m}`,
          m.params,
        );

        // Percentiles can't be summed across buckets, so p95 is computed from raw events.
        // The time index keeps this bounded, and the result is cached like the totals.
        const r = metricsWhere(ctx, range, "started_at", args.projectId, args.model);
        const p95Query = ctx.pool.query<{ p95: number | null }>(
          `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
           FROM request_events WHERE ${r}`,
          r.params,
        );

        const [totals, p95] = await Promise.all([totalsQuery, p95Query]);
        const t = totals.rows[0];
        const requestCount = num(t.requests);
        const errorCount = num(t.errors);
        return {
          requestCount,
          errorCount,
          errorRate: requestCount ? errorCount / requestCount : 0,
          inputTokens: num(t.input_tokens),
          outputTokens: num(t.output_tokens),
          estimatedCostUsd: microsToUsd(num(t.cost_micros)),
          avgLatencyMs: requestCount ? num(t.latency_sum) / requestCount : null,
          p95LatencyMs: p95.rows[0]?.p95 ?? null,
        };
      });
    },

    usageSeries: async (
      _: unknown,
      args: { range: TimeRange; interval: Interval; projectId?: string | null; model?: string | null },
      ctx: Context,
    ) => {
      const range = parseRange(args.range);
      const span = Date.parse(range.to) - Date.parse(range.from);
      if (span / INTERVAL_MS[args.interval] > MAX_SERIES_POINTS) {
        throw badInput(`This range has too many ${args.interval.toLowerCase()} points; choose a larger interval`);
      }
      const key = { range, interval: args.interval, projectId: args.projectId ?? null, model: args.model ?? null };

      return cached(ctx.redis, ctx.tenantId, "usageSeries", key, AGGREGATE_TTL_SECONDS, async () => {
        const w = metricsWhere(ctx, range, "bucket_start", args.projectId, args.model);
        const unit = w.param(args.interval.toLowerCase()); // whitelisted by the GraphQL enum
        const { rows } = await ctx.pool.query<Record<string, string | Date | null>>(
          `SELECT date_trunc(${unit}, bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS t,
                  sum(request_count)               AS requests,
                  sum(error_count)                 AS errors,
                  sum(input_tokens + output_tokens) AS tokens,
                  sum(cost_micros)                 AS cost_micros,
                  sum(latency_sum_ms)              AS latency_sum
           FROM metrics_minute
           WHERE ${w}
           GROUP BY 1
           ORDER BY 1`,
          w.params,
        );
        return rows.map((r) => {
          const requestCount = num(r.requests as string);
          return {
            t: (r.t as Date).toISOString(),
            requestCount,
            errorCount: num(r.errors as string),
            tokens: num(r.tokens as string),
            estimatedCostUsd: microsToUsd(num(r.cost_micros as string)),
            avgLatencyMs: requestCount ? num(r.latency_sum as string) / requestCount : null,
          };
        });
      });
    },
  },

  Project: {
    apiKeys: async (project: { id: string }, _: unknown, ctx: Context) => {
      const { rows } = await ctx.pool.query<ApiKeyRow>(
        `SELECT ${API_KEY_COLUMNS} FROM api_keys
         WHERE tenant_id = $1 AND project_id = $2
         ORDER BY revoked_at IS NOT NULL, created_at DESC`,
        [ctx.tenantId, project.id],
      );
      return rows.map(toApiKey);
    },
  },

  Mutation: {
    createProject: async (_: unknown, args: { name: string }, ctx: Context) => {
      const name = args.name.trim();
      if (name.length < 1 || name.length > 64) throw badInput("Project name must be 1-64 characters");
      try {
        const { rows } = await ctx.pool.query<{ id: string; name: string; created_at: Date }>(
          `INSERT INTO projects (tenant_id, name) VALUES ($1, $2) RETURNING id, name, created_at`,
          [ctx.tenantId, name],
        );
        return { id: rows[0].id, name: rows[0].name, createdAt: rows[0].created_at.toISOString() };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw badInput(`A project named "${name}" already exists`);
        throw err;
      }
    },

    createApiKey: async (_: unknown, args: { projectId: string; name: string }, ctx: Context) => {
      const name = args.name.trim();
      if (name.length < 1 || name.length > 64) throw badInput("Key name must be 1-64 characters");
      const key = generateApiKey();
      // Inserting via SELECT from projects enforces that the project belongs to this tenant.
      const { rows } = await ctx.pool.query<ApiKeyRow>(
        `INSERT INTO api_keys (tenant_id, project_id, name, prefix, key_hash)
         SELECT tenant_id, id, $3, $4, $5 FROM projects WHERE id = $2 AND tenant_id = $1
         RETURNING ${API_KEY_COLUMNS}`,
        [ctx.tenantId, assertUuid(args.projectId, "projectId"), name, key.prefix, key.hash],
      );
      if (!rows[0]) throw notFound("Project not found");
      return { apiKey: toApiKey(rows[0]), secret: key.secret };
    },

    revokeApiKey: async (_: unknown, args: { id: string }, ctx: Context) => {
      const { rows } = await ctx.pool.query<ApiKeyRow>(
        `UPDATE api_keys SET revoked_at = coalesce(revoked_at, now())
         WHERE id = $1 AND tenant_id = $2
         RETURNING ${API_KEY_COLUMNS}`,
        [assertUuid(args.id, "id"), ctx.tenantId],
      );
      if (!rows[0]) throw notFound("API key not found");
      return toApiKey(rows[0]);
    },
  },
};
