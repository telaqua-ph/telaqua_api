/**
 * api/auth/change-password.js
 *
 * PUT /api/auth/change-password
 *
 * Allows the authenticated admin to change their password.
 */

import bcrypt from "bcryptjs";
import { sql } from "../../lib/db.js";
import { requireAuth } from "../../middleware/auth.js";

const BCRYPT_SALT_ROUNDS = 12;

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

  if (req.method !== "PUT") {
    return json(res, 405, {
      success: false,
      message: "Method not allowed",
    });
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
    const body = parseBody(req);
    if (body === null) {
      return json(res, 400, {
        success: false,
        message: "Invalid JSON body",
      });
    }

    const current_password =
      typeof body.current_password === "string" ? body.current_password : "";
    const new_password =
      typeof body.new_password === "string" ? body.new_password : "";
    const confirm_password =
      typeof body.confirm_password === "string" ? body.confirm_password : "";

    if (!current_password || !new_password || !confirm_password) {
      return json(res, 400, {
        success: false,
        message:
          "current_password, new_password, and confirm_password are required",
      });
    }

    if (new_password !== confirm_password) {
      return json(res, 400, {
        success: false,
        message: "new_password and confirm_password do not match",
      });
    }

    if (new_password.length < 8) {
      return json(res, 400, {
        success: false,
        message: "new_password must be at least 8 characters",
      });
    }

    const { rows } = await sql`
      SELECT id, password_hash
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

    const admin = rows[0];
    const isMatch = await bcrypt.compare(current_password, admin.password_hash);

    if (!isMatch) {
      return json(res, 401, {
        success: false,
        message: "Current password is incorrect",
      });
    }

    const password_hash = await bcrypt.hash(new_password, BCRYPT_SALT_ROUNDS);

    await sql`
      UPDATE admins
      SET
        password_hash = ${password_hash},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${adminId}
    `;

    return json(res, 200, {
      success: true,
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Change password API error:", error);
    return json(res, 500, {
      success: false,
      message: "Internal server error",
    });
  }
}
