/**
 * controllers/orderController.js
 *
 * Orders business logic — preserved from Vercel serverless handlers.
 * Includes restored DELETE /api/orders/:id.
 */

import { query } from "../config/db.js";
import {
  ensureWhatsappConsentColumns,
  parseWhatsappConsent,
} from "../services/whatsappConsent.js";

const ALLOWED_ORDER_STATUSES = [
  "New",
  "Confirmed",
  "Processing",
  "Shipped",
  "Delivered",
  "Cancelled",
];

const ALLOWED_PAYMENT_STATUSES = ["Pending", "Paid", "Failed", "Refunded"];

function trimStr(value) {
  return typeof value === "string" ? value.trim() : value;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

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

  const consent = parseWhatsappConsent(body);
  if (consent.error) {
    return { error: consent.error };
  }

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
      whatsapp_updates_consent: consent.whatsapp_updates_consent,
      whatsapp_consent_at: consent.whatsapp_consent_at,
    },
  };
}

function parseOrderId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  return id;
}

/** GET /api/orders */
export async function listOrders(req, res) {
  try {
    const { rows } = await query(
      `SELECT *
       FROM orders
       ORDER BY created_at DESC
       LIMIT 100`
    );

    return res.status(200).json({
      success: true,
      orders: rows,
    });
  } catch (error) {
    console.error("Orders API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** POST /api/orders */
export async function createOrder(req, res) {
  try {
    const body = req.body;
    if (body == null || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        message: "Invalid JSON body",
      });
    }

    const validation = validateCreateOrder(body);
    if (validation.error) {
      return res.status(400).json({
        success: false,
        message: validation.error,
      });
    }

    const orderData = validation.data;

    try {
      await ensureWhatsappConsentColumns();
    } catch (colErr) {
      console.error("WhatsApp consent columns ensure failed:", colErr?.message);
      return res.status(500).json({
        success: false,
        message:
          "Orders table is missing WhatsApp consent columns. Run sql/add_whatsapp_consent.sql",
      });
    }

    const { rows: duplicates } = await query(
      `SELECT id
       FROM orders
       WHERE phone = $1
         AND total_amount = $2
         AND created_at >= NOW() - INTERVAL '2 minutes'
       LIMIT 1`,
      [orderData.phone, orderData.total_amount]
    );

    if (duplicates.length > 0) {
      return res.status(409).json({
        success: false,
        message:
          "Duplicate order detected. Please wait before placing another order.",
      });
    }

    const { rows: inserted } = await query(
      `INSERT INTO orders (
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
        order_status,
        whatsapp_updates_consent,
        whatsapp_consent_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'Pending', 'New', $12, $13
      )
      RETURNING id`,
      [
        orderData.customer_name,
        orderData.phone,
        orderData.email,
        orderData.address,
        orderData.city,
        orderData.state,
        orderData.pincode,
        orderData.quantity,
        orderData.unit_price,
        orderData.total_amount,
        orderData.payment_method,
        orderData.whatsapp_updates_consent,
        orderData.whatsapp_consent_at,
      ]
    );

    const id = inserted[0].id;
    const orderNumber = `TAQ-${String(id).padStart(6, "0")}`;

    const { rows } = await query(
      `UPDATE orders
       SET order_number = $1
       WHERE id = $2
       RETURNING *`,
      [orderNumber, id]
    );

    return res.status(201).json({
      success: true,
      message: "Order created successfully",
      order: rows[0],
    });
  } catch (error) {
    console.error("Orders API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** GET /api/orders/:id */
export async function getOrderById(req, res) {
  try {
    const id = parseOrderId(req.params.id);
    if (id === null) {
      return res.status(400).json({
        success: false,
        message: "Invalid order id",
      });
    }

    const { rows } = await query(
      `SELECT *
       FROM orders
       WHERE id = $1`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    return res.status(200).json({
      success: true,
      order: rows[0],
    });
  } catch (error) {
    console.error("Order by id API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** PUT /api/orders/:id */
export async function updateOrder(req, res) {
  try {
    const id = parseOrderId(req.params.id);
    if (id === null) {
      return res.status(400).json({
        success: false,
        message: "Invalid order id",
      });
    }

    const body = req.body;
    if (body == null || typeof body !== "object") {
      return res.status(400).json({
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

    if (order_status === undefined && payment_status === undefined) {
      return res.status(400).json({
        success: false,
        message: "Provide order_status and/or payment_status to update",
      });
    }

    if (
      order_status !== undefined &&
      !ALLOWED_ORDER_STATUSES.includes(order_status)
    ) {
      return res.status(400).json({
        success: false,
        message: `Invalid order_status. Allowed values: ${ALLOWED_ORDER_STATUSES.join(", ")}`,
      });
    }

    if (
      payment_status !== undefined &&
      !ALLOWED_PAYMENT_STATUSES.includes(payment_status)
    ) {
      return res.status(400).json({
        success: false,
        message: `Invalid payment_status. Allowed values: ${ALLOWED_PAYMENT_STATUSES.join(", ")}`,
      });
    }

    const { rows: existing } = await query(
      `SELECT id FROM orders WHERE id = $1`,
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const { rows } = await query(
      `UPDATE orders
       SET
         order_status = COALESCE($1, order_status),
         payment_status = COALESCE($2, payment_status),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [order_status ?? null, payment_status ?? null, id]
    );

    return res.status(200).json({
      success: true,
      message: "Order updated successfully",
      order: rows[0],
    });
  } catch (error) {
    console.error("Order by id API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** DELETE /api/orders/:id — restored */
export async function deleteOrder(req, res) {
  try {
    const id = parseOrderId(req.params.id);
    if (id === null) {
      return res.status(400).json({
        success: false,
        message: "Invalid order id",
      });
    }

    const { rows } = await query(
      `DELETE FROM orders
       WHERE id = $1
       RETURNING id`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Order deleted successfully",
    });
  } catch (error) {
    console.error("Order by id API error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}
