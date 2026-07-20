/**
 * api/orders/[id].js
 *
 * /api/orders/:id
 *
 * Purpose:
 * - GET    — fetch a single order by ID
 * - PUT    — update order status / details (admin)
 * - DELETE — cancel or remove an order (admin)
 *
 * Dynamic segment: req.query.id
 *
 * Consumers: Admin Dashboard, Tel-Aqua website (order tracking)
 *
 * TODO: Implement get / update / delete order handlers.
 */

export default async function handler(req, res) {
  // Placeholder — single-order logic will be implemented here.
  res.statusCode = 501;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ message: "Not implemented: /api/orders/:id" }));
}
