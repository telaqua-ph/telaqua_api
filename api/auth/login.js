/**
 * api/auth/login.js
 *
 * POST /api/auth/login
 *
 * Purpose:
 * - Authenticate a user (admin or customer) with email + password
 * - Issue a JWT on successful login
 * - Return user profile + token to the client
 *
 * Consumers: Admin Dashboard, Tel-Aqua website (if customer login is enabled)
 *
 * TODO: Implement login handler (validate body → verify credentials → sign JWT).
 */

export default async function handler(req, res) {
  // Placeholder — login logic will be implemented here.
  res.statusCode = 501;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ message: "Not implemented: POST /api/auth/login" }));
}
