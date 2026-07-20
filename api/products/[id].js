/**
 * api/products/[id].js
 *
 * /api/products/:id
 *
 * Purpose:
 * - GET    — fetch a single product by ID
 * - PUT    — update a product (admin)
 * - DELETE — remove a product (admin)
 *
 * Dynamic segment: req.query.id
 *
 * Consumers: Tel-Aqua website (detail), Admin Dashboard (manage)
 *
 * TODO: Implement get / update / delete product handlers.
 */

export default async function handler(req, res) {
  // Placeholder — single-product logic will be implemented here.
  res.statusCode = 501;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ message: "Not implemented: /api/products/:id" }));
}
