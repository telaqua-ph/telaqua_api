/**
 * lib/db.js
 *
 * Shared database client for Vercel Postgres (Neon).
 * Connection credentials come from environment variables
 * (POSTGRES_URL / POSTGRES_URL_NON_POOLING) — never hardcode secrets.
 */

import { sql } from "@vercel/postgres";

export { sql };
