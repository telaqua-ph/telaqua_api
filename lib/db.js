/**
 * lib/db.js
 *
 * Re-exports the shared pg pool for backwards-compatible imports.
 * Prefer importing from config/db.js in new code.
 */

export { query, pool } from "../config/db.js";
