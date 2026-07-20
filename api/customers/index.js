/**
 * api/customers/index.js
 *
 * /api/customers
 *
 * Purpose:
 * - GET  — list customers (admin)
 * - POST — create / register a customer
 *
 * Consumers: Admin Dashboard (list), Tel-Aqua website (register)
 *
 * TODO: Implement list and create customer handlers.
 */

export default async function handler(req, res) {
  // Placeholder — customer collection logic will be implemented here.
  res.statusCode = 501;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ message: "Not implemented: /api/customers" }));
}
