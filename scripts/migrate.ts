import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8");
  await pool.query(sql);
  await pool.end();
  console.log("Schema applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
