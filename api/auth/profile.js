/**
 * api/auth/profile.js
 *
 * /api/auth/profile
 * - GET — return the authenticated admin profile
 * - PUT — update full_name and/or email
 */

import { sql } from "../../lib/db.js";
import { requireAuth } from "../../middleware/auth.js";

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

function trimStr(value) {
  return typeof value === "string" ? value.trim() : value;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!requireAuth(req, res)) return;

  const adminId = req.user?.admin_id;
  if (!adminId) {
    return json(res, 401, {
      success: false,
      message: "Unauthorized",
    });
  }

  try {
    if (req.method === "GET") {
      const { rows } = await sql`
        SELECT id, full_name, username, email, is_active, last_login, created_at, updated_at
        FROM admins
        WHERE id = ${adminId}
          AND is_active = true
        LIMIT 1
      `;

      if (rows.length === 0) {
        return json(res, 404, {
          success: false,
          message: "Admin not found",
        });
      }

      return json(res, 200, {
        success: true,
        admin: rows[0],
      });
    }

    if (req.method === "PUT") {
      const body = parseBody(req);
      if (body === null) {
        return json(res, 400, {
          success: false,
          message: "Invalid JSON body",
        });
      }

      const full_name =
        body.full_name !== undefined ? trimStr(body.full_name) : undefined;
      const emailRaw =
        body.email !== undefined ? trimStr(body.email) : undefined;

      if (full_name === undefined && emailRaw === undefined) {
        return json(res, 400, {
          success: false,
          message: "Provide full_name and/or email to update",
        });
      }

      if (full_name !== undefined && !full_name) {
        return json(res, 400, {
          success: false,
          message: "full_name cannot be empty",
        });
      }

      let email = undefined;
      if (emailRaw !== undefined) {
        const normalized = String(emailRaw).toLowerCase();
        if (!normalized || !isValidEmail(normalized)) {
          return json(res, 400, {
            success: false,
            message: "email must be a valid email address",
          });
        }
        email = normalized;
      }

      // Ensure the admin still exists and is active
      const { rows: existing } = await sql`
        SELECT id FROM admins
        WHERE id = ${adminId}
          AND is_active = true
        LIMIT 1
      `;

      if (existing.length === 0) {
        return json(res, 404, {
          success: false,
          message: "Admin not found",
        });
      }

      // If email is changing, ensure it is not taken by another admin
      if (email !== undefined) {
        const { rows: taken } = await sql`
          SELECT id FROM admins
          WHERE email = ${email}
            AND id <> ${adminId}
          LIMIT 1
        `;
        if (taken.length > 0) {
          return json(res, 409, {
            success: false,
            message: "Email is already in use",
          });
        }
      }

      const { rows } = await sql`
        UPDATE admins
        SET
          full_name = COALESCE(${full_name ?? null}, full_name),
          email = COALESCE(${email ?? null}, email),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${adminId}
        RETURNING id, full_name, username, email, is_active, last_login, created_at, updated_at
      `;

      return json(res, 200, {
        success: true,
        message: "Profile updated successfully",
        admin: rows[0],
      });
    }

    return json(res, 405, {
      success: false,
      message: "Method not allowed",
    });
  } catch (error) {
    console.error("Profile API error:", error);
    return json(res, 500, {
      success: false,
      message: "Internal server error",
    });
  }
}
