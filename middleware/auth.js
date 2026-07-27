/**
 * middleware/auth.js
 *
 * JWT verification middleware for protected admin routes.
 *
 * Expects: Authorization: Bearer <token>
 * Verifies with process.env.JWT_SECRET
 */

import { verifyToken } from "../lib/auth.js";

/**
 * Require a valid Bearer JWT on the request.
 * On success: attaches payload to req.user and returns true.
 * On failure: sends HTTP 401 JSON and returns false.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean}
 */
export function requireAuth(req, res) {
  const header = req.headers.authorization || req.headers.Authorization;

  if (!header || typeof header !== "string" || !header.startsWith("Bearer ")) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        success: false,
        message: "Unauthorized",
      })
    );
    return false;
  }

  const token = header.slice("Bearer ".length).trim();

  if (!token) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        success: false,
        message: "Unauthorized",
      })
    );
    return false;
  }

  try {
    const payload = verifyToken(token);
    req.user = payload;
    return true;
  } catch {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        success: false,
        message: "Unauthorized",
      })
    );
    return false;
  }
}
