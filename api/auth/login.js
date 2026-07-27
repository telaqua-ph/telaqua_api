/**
 * api/auth/login.js
 *
 * POST /api/auth/login
 *
 * Authenticates against process.env.ADMIN_USERNAME / ADMIN_PASSWORD
 * and returns a JWT signed with process.env.JWT_SECRET (24h expiry).
 */

import { signToken } from "../../lib/auth.js";

/** Apply CORS headers for browser clients. */
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
}

/** Send a JSON response with the given status code. */
function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

/** Parse request body (string or already-parsed object). */
function parseBody(req) {
  if (req.body == null || req.body === "") return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return req.body;
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      message: "Method not allowed",
    });
  }

  try {
    const body = parseBody(req);
    if (body === null) {
      return json(res, 400, {
        success: false,
        message: "Invalid JSON body",
      });
    }

    const username =
      typeof body.username === "string" ? body.username.trim() : "";
    const password =
      typeof body.password === "string" ? body.password : "";

    // Credentials come only from Vercel environment variables
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (
      !adminUsername ||
      !adminPassword ||
      username !== adminUsername ||
      password !== adminPassword
    ) {
      return json(res, 401, {
        success: false,
        message: "Invalid username or password",
      });
    }

    // JWT_SECRET is used only for signing (inside signToken)
    const token = signToken({ username: adminUsername });

    return json(res, 200, {
      success: true,
      token,
    });
  } catch (error) {
    console.error("Login API error:", error);
    return json(res, 500, {
      success: false,
      message: "Internal server error",
    });
  }
}
