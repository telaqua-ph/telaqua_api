/**
 * api/dashboard/stats.js
 *
 * GET /api/dashboard/stats
 *
 * Purpose:
 * - Return aggregated metrics for the Admin Dashboard
 *   (e.g. total orders, revenue, customers, low-stock products)
 * - Protected: admin-only
 *
 * Consumers: React + Vite Admin Dashboard
 *
 * TODO: Implement stats aggregation queries against Vercel Postgres.
 */

export default async function handler(req, res) {
  // Placeholder — dashboard stats logic will be implemented here.
  res.statusCode = 501;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ message: "Not implemented: GET /api/dashboard/stats" }));
}
