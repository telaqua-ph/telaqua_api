/**
 * Apply inventory schema to Neon/PostgreSQL.
 * Usage: node scripts/migrate-inventory.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(__dirname, "..", "sql", "add_inventory.sql");

async function main() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlPath, "utf8");
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    await client.query(sql);
    console.log("Inventory migration applied successfully.");
  } catch (err) {
    console.error("Inventory migration failed:", err?.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
