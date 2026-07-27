/**
 * api/orders/index.js
 *
 * /api/orders
 * - GET  — list latest 100 orders (newest first)
 * - POST — create a new order (with duplicate prevention)
 */

import { sql } from "../../lib/db.js";

/** Apply CORS headers for browser clients. */
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

/** Basic email format check (optional field). */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Validate and normalize POST body.
 * Returns { data } on success or { error } with a 400 message.
 */
function validateCreateOrder(body) {
  if (!body || typeof body !== "object") {
    return { error: "Invalid JSON body" };
  }

  const customer_name = trimStr(body.customer_name);
  const phone = trimStr(body.phone);
  const emailRaw = trimStr(body.email);
  const address = trimStr(body.address);
  const city = trimStr(body.city);
  const state = trimStr(body.state);
  const pincode = trimStr(body.pincode);
  const payment_method = trimStr(body.payment_method);

  const quantity = Number(body.quantity);
  const unit_price = Number(body.unit_price);
  const total_amount = Number(body.total_amount);

  if (!customer_name) {
    return { error: "customer_name is required" };
  }
  if (!phone) {
    return { error: "phone is required" };
  }
  if (!/^\d{10}$/.test(String(phone))) {
    return { error: "phone must contain exactly 10 digits" };
  }
  if (!address) {
    return { error: "address is required" };
  }
  if (body.quantity === undefined || body.quantity === null || body.quantity === "") {
    return { error: "quantity is required" };
  }
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
    return { error: "quantity must be an integer greater than 0" };
  }
  if (body.unit_price === undefined || body.unit_price === null || body.unit_price === "") {
    return { error: "unit_price is required" };
  }
  if (!Number.isFinite(unit_price) || unit_price <= 0) {
    return { error: "unit_price must be a positive number" };
  }
  if (body.total_amount === undefined || body.total_amount === null || body.total_amount === "") {
    return { error: "total_amount is required" };
  }
  if (!Number.isFinite(total_amount) || total_amount <= 0) {
    return { error: "total_amount must be a positive number" };
  }
  if (!payment_method) {
    return { error: "payment_method is required" };
  }

  // Email is optional; validate format only when provided
  let email = null;
  if (emailRaw !== undefined && emailRaw !== null && emailRaw !== "") {
    if (!isValidEmail(emailRaw)) {
      return { error: "email must be a valid email address" };
    }
    email = emailRaw;
  }

  return {
    data: {
      customer_name,
      phone: String(phone),
      email,
      address,
      city: city || null,
      state: state || null,
      pincode: pincode || null,
      quantity,
      unit_price,
      total_amount,
      payment_method,
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
    if (req.method === "GET") {
      const { rows } = await sql`
        SELECT *
        FROM orders
        ORDER BY created_at DESC
        LIMIT 100
      `;

      return json(res, 200, {
        success: true,
        orders: rows,
      });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      if (body === null) {
        return json(res, 400, {
          success: false,
          message: "Invalid JSON body",
        });
      }

      const validation = validateCreateOrder(body);
      if (validation.error) {
        return json(res, 400, {
          success: false,
          message: validation.error,
        });
      }

      const orderData = validation.data;

      // Duplicate prevention: same phone + total within the last 2 minutes
      const { rows: duplicates } = await sql`
        SELECT id
        FROM orders
        WHERE phone = ${orderData.phone}
          AND total_amount = ${orderData.total_amount}
          AND created_at >= NOW() - INTERVAL '2 minutes'
        LIMIT 1
      `;

      if (duplicates.length > 0) {
        return json(res, 409, {
          success: false,
          message:
            "Duplicate order detected. Please wait before placing another order.",
        });
      }

      // Insert order, then set unique order_number from the serial id (TAQ-000001)
      const { rows } = await sql`
        WITH inserted AS (
          INSERT INTO orders (
            customer_name,
            phone,
            email,
            address,
            city,
            state,
            pincode,
            quantity,
            unit_price,
            total_amount,
            payment_method,
            payment_status,
            order_status
          ) VALUES (
            ${orderData.customer_name},
            ${orderData.phone},
            ${orderData.email},
            ${orderData.address},
            ${orderData.city},
            ${orderData.state},
            ${orderData.pincode},
            ${orderData.quantity},
            ${orderData.unit_price},
            ${orderData.total_amount},
            ${orderData.payment_method},
            'Pending',
            'New'
          )
          RETURNING id
        )
        UPDATE orders o
        SET order_number = 'TAQ-' || LPAD(inserted.id::text, 6, '0')
        FROM inserted
        WHERE o.id = inserted.id
        RETURNING o.*
      `;

      return json(res, 201, {
        success: true,
        message: "Order created successfully",
        order: rows[0],
      });
    }

    return json(res, 405, {
      success: false,
      message: "Method not allowed",
    });
  } catch (error) {
    console.error("Orders API error:", error);
    return json(res, 500, {
      success: false,
      message: "Internal server error",
    });
  }
}
