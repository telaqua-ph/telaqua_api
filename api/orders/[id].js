/**
 * api/orders/[id].js
 *
 * /api/orders/:id
 * - GET — fetch a single order by id
 * - PUT — update order_status and/or payment_status
 */

import { sql } from "../../lib/db.js";
import { requireAuth } from "../../middleware/auth.js";

const ALLOWED_ORDER_STATUSES = [
  "New",
  "Confirmed",
  "Processing",
  "Shipped",
  "Delivered",
  "Cancelled",
];

const ALLOWED_PAYMENT_STATUSES = ["Pending", "Paid", "Failed", "Refunded"];

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

/** Resolve and validate the dynamic :id segment. */
function parseOrderId(req) {
  const raw = req.query?.id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  return id;
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
    const id = parseOrderId(req);
    if (id === null) {
      return json(res, 400, {
        success: false,
        message: "Invalid order id",
      });
    }

    if (req.method === "GET") {
      const { rows } = await sql`
        SELECT *
        FROM orders
        WHERE id = ${id}
      `;

      if (rows.length === 0) {
        return json(res, 404, {
          success: false,
          message: "Order not found",
        });
      }

      return json(res, 200, {
        success: true,
        order: rows[0],
      });
    }

    if (req.method === "PUT") {
      // Admin only — update order status
      if (!requireAuth(req, res)) return;

      const body = parseBody(req);
      if (body === null) {
        return json(res, 400, {
          success: false,
          message: "Invalid JSON body",
        });
      }

      const order_status =
        body.order_status !== undefined ? trimStr(body.order_status) : undefined;
      const payment_status =
        body.payment_status !== undefined
          ? trimStr(body.payment_status)
          : undefined;

      // Only order_status and payment_status may be updated
      if (order_status === undefined && payment_status === undefined) {
        return json(res, 400, {
          success: false,
          message: "Provide order_status and/or payment_status to update",
        });
      }

      if (
        order_status !== undefined &&
        !ALLOWED_ORDER_STATUSES.includes(order_status)
      ) {
        return json(res, 400, {
          success: false,
          message: `Invalid order_status. Allowed values: ${ALLOWED_ORDER_STATUSES.join(", ")}`,
        });
      }

      if (
        payment_status !== undefined &&
        !ALLOWED_PAYMENT_STATUSES.includes(payment_status)
      ) {
        return json(res, 400, {
          success: false,
          message: `Invalid payment_status. Allowed values: ${ALLOWED_PAYMENT_STATUSES.join(", ")}`,
        });
      }

      // Ensure the order exists before updating
      const { rows: existing } = await sql`
        SELECT id FROM orders WHERE id = ${id}
      `;

      if (existing.length === 0) {
        return json(res, 404, {
          success: false,
          message: "Order not found",
        });
      }

      const { rows } = await sql`
        UPDATE orders
        SET
          order_status = COALESCE(${order_status ?? null}, order_status),
          payment_status = COALESCE(${payment_status ?? null}, payment_status),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
        RETURNING *
      `;

      return json(res, 200, {
        success: true,
        message: "Order updated successfully",
        order: rows[0],
      });
    }

    return json(res, 405, {
      success: false,
      message: "Method not allowed",
    });
  } catch (error) {
    console.error("Order by id API error:", error);
    return json(res, 500, {
      success: false,
      message: "Internal server error",
    });
  }
}
