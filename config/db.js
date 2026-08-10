/**
 * config/db.js
 *
 * PostgreSQL connection pool (Neon / any Postgres).
 * Uses process.env.DATABASE_URL — never hardcode credentials.
 *
 * Important for Hostinger: missing DATABASE_URL must not crash the
 * HTTP server at import time. Health routes still work; DB routes fail
 * with a clear error when queried.
 */

import pg from "pg";

const { Pool } = pg;

const databaseUrl = (process.env.DATABASE_URL || "").trim();

if (!databaseUrl) {
  console.warn(
    "Warning: DATABASE_URL is not set. Database queries will fail until it is configured."
  );
}

const pool = new Pool({
  connectionString: databaseUrl || undefined,
  // Neon and most cloud Postgres require SSL when a URL is present
  ssl: databaseUrl ? { rejectUnauthorized: false } : undefined,
  // Keep idle clients from holding connections forever on PaaS
  max: Number(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Without this listener, idle client errors can crash the Node process (503 on Hostinger)
pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", {
    message: err?.message,
    code: err?.code,
  });
});

/**
 * Run a parameterized SQL query.
 * @param {string} text
 * @param {any[]} [params]
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params = []) {
  if (!databaseUrl) {
    const err = new Error("DATABASE_URL is not configured");
    err.code = "DB_CONFIG_ERROR";
    throw err;
  }

  return pool.query(text, params);
}

export { pool };
