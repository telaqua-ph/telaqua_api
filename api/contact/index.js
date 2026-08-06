/**
 * api/contact/index.js
 *
 * /api/contact
 * - POST — submit a contact form message
 *
 * Consumers: Tel-Aqua website (contact form)
 */

import { sql } from "../../lib/db.js";

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

/** Trim a value if it is a string; otherwise return as-is. */
function trimStr(value) {
  return typeof value === "string" ? value.trim() : value;
}

/**
 * Validate and normalize the contact form payload.
 * Returns { data } on success or { error } on validation failure.
 */
function validateContactMessage(body) {
  if (!body || typeof body !== "object") {
    return { error: "All fields are required" };
  }

  const full_name = trimStr(body.full_name);
  const phone = trimStr(body.phone);
  const email = trimStr(body.email);
  const message = trimStr(body.message);

  if (!full_name || !phone || !email || !message) {
    return { error: "All fields are required" };
  }

  return {
    data: {
      full_name: String(full_name),
      phone: String(phone),
      email: String(email),
      message: String(message),
    },
  };
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    if (req.method === "POST") {
      const body = parseBody(req);
      if (body === null) {
        return json(res, 400, {
          success: false,
          message: "All fields are required",
        });
      }

      const validation = validateContactMessage(body);
      if (validation.error) {
        return json(res, 400, {
          success: false,
          message: validation.error,
        });
      }

      const { full_name, phone, email, message } = validation.data;

      // Insert into contact_messages (created_at uses DB default when available)
      await sql`
        INSERT INTO contact_messages (
          full_name,
          phone,
          email,
          message
        ) VALUES (
          ${full_name},
          ${phone},
          ${email},
          ${message}
        )
      `;

      return json(res, 201, {
        success: true,
        message: "Message submitted successfully",
      });
    }

    return json(res, 405, {
      success: false,
      message: "Method not allowed",
    });
  } catch (error) {
    console.error("Contact API error:", error);
    return json(res, 500, {
      success: false,
      message: "Internal server error",
    });
  }
}
