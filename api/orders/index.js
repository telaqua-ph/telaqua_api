/**
 * api/orders/index.js
 *
 * /api/orders
 *
 * Purpose:
 * - GET  — list orders (with optional filters / pagination)
 * - POST — create a new order (checkout from the customer website)
 *
 * Consumers: Admin Dashboard (list), Tel-Aqua website (create)
 *
 * TODO: Implement list and create order handlers.
 */

export default async function handler(req, res) {
  // Placeholder — order collection logic will be implemented here.
  res.statusCode = 501;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ message: "Not implemented: /api/orders" }));
}
