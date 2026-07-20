/**
 * api/products/index.js
 *
 * /api/products
 *
 * Purpose:
 * - GET  — list products (public catalog for the website)
 * - POST — create a product (admin)
 *
 * Consumers: Tel-Aqua website (list), Admin Dashboard (create)
 *
 * TODO: Implement list and create product handlers.
 */

export default async function handler(req, res) {
  // Placeholder — product collection logic will be implemented here.
  res.statusCode = 501;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ message: "Not implemented: /api/products" }));
}
