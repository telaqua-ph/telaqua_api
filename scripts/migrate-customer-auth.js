import "dotenv/config";
import fs from "node:fs/promises";
import { pool } from "../config/db.js";

try {
  const sql = await fs.readFile(
    new URL("../sql/add_customer_auth.sql", import.meta.url),
    "utf8"
  );
  await pool.query(sql);
  console.log("Customer authentication migration completed");
} catch (error) {
  console.error("Customer authentication migration failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
