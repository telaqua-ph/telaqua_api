/**
 * api/customers/[id].js
 *
 * /api/customers/:id
 *
 * Purpose:
 * - GET    — fetch a single customer by ID
 * - PUT    — update customer profile
 * - DELETE — deactivate / remove a customer (admin)
 *
 * Dynamic segment: req.query.id
 *
 * Consumers: Admin Dashboard, Tel-Aqua website (account)
 *
 * TODO: Implement get / update / delete customer handlers.
 */

export default async function handler(req, res) {
  // Placeholder — single-customer logic will be implemented here.
  res.statusCode = 501;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ message: "Not implemented: /api/customers/:id" }));
}
