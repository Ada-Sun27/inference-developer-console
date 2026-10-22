-- Inference Developer Console schema (PostgreSQL 13+ for gen_random_uuid()).

CREATE TABLE IF NOT EXISTS tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- Only a SHA-256 hash of each key is stored; the secret is shown once at creation.
CREATE TABLE IF NOT EXISTS api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  project_id   uuid NOT NULL REFERENCES projects(id),
  name         text NOT NULL,
  prefix       text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_project_idx ON api_keys (tenant_id, project_id);

-- Raw request events: the source of truth. Aggregates can always be rebuilt from here.
CREATE TABLE IF NOT EXISTS request_events (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  project_id    uuid NOT NULL,
  request_id    text NOT NULL,
  model         text NOT NULL,
  status        text NOT NULL CHECK (status IN ('success', 'error')),
  error_code    text,
  input_tokens  integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  cost_micros   bigint  NOT NULL CHECK (cost_micros >= 0),  -- estimated cost in micro-USD
  latency_ms    integer NOT NULL CHECK (latency_ms >= 0),
  started_at    timestamptz NOT NULL,                       -- event time (when the request ran)
  received_at   timestamptz NOT NULL DEFAULT now(),         -- ingestion time
  UNIQUE (tenant_id, request_id)                            -- idempotency key
);
-- Keyset pagination: newest first, tie-broken by id.
CREATE INDEX IF NOT EXISTS request_events_tenant_time_idx
  ON request_events (tenant_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS request_events_project_time_idx
  ON request_events (tenant_id, project_id, started_at DESC, id DESC);

-- Work queue: minute buckets whose aggregates are stale because new events landed in them.
CREATE TABLE IF NOT EXISTS dirty_buckets (
  tenant_id    uuid NOT NULL,
  project_id   uuid NOT NULL,
  bucket_start timestamptz NOT NULL,
  marked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, bucket_start)
);
CREATE INDEX IF NOT EXISTS dirty_buckets_marked_idx ON dirty_buckets (marked_at);

-- Per-minute rollups that the dashboard reads.
CREATE TABLE IF NOT EXISTS metrics_minute (
  tenant_id      uuid NOT NULL,
  project_id     uuid NOT NULL,
  model          text NOT NULL,
  bucket_start   timestamptz NOT NULL,
  request_count  integer NOT NULL,
  error_count    integer NOT NULL,
  input_tokens   bigint  NOT NULL,
  output_tokens  bigint  NOT NULL,
  cost_micros    bigint  NOT NULL,
  latency_sum_ms bigint  NOT NULL,
  latency_max_ms integer NOT NULL,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, bucket_start, model)
);
CREATE INDEX IF NOT EXISTS metrics_minute_tenant_time_idx ON metrics_minute (tenant_id, bucket_start);
