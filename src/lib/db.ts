import { Pool } from "pg";

// Reuse one pool across Next.js hot reloads in development.
const globalForPg = globalThis as unknown as { __pgPool?: Pool };

export const pool =
  globalForPg.__pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX ?? 10),
  });

if (process.env.NODE_ENV !== "production") globalForPg.__pgPool = pool;
