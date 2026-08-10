/**
 * config/db.js
 *
 * PostgreSQL connection pool (Neon / any Postgres).
 * Uses process.env.DATABASE_URL — never hardcode credentials.
 */

import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn(
    "Warning: DATABASE_URL is not set. Database queries will fail."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon and most cloud Postgres require SSL
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined,
});

/**
 * Run a parameterized SQL query.
 * @param {string} text
 * @param {any[]} [params]
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params = []) {
  return pool.query(text, params);
}

export { pool };
