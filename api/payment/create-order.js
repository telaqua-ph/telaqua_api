/**
 * api/payment/create-order.js
 *
 * POST /api/payment/create-order
 *
 * Razorpay Test Mode — Create Order (Phase 1)
 *
 * Flow:
 * 1. Validate required customer + quantity fields
 * 2. Calculate unit_price / total_amount on the server (never trust the client)
 * 3. Create a Razorpay Order via the official SDK (amount in paise)
 * 4. Insert a Pending row into the existing orders table with razorpay_order_id
 * 5. Return Checkout-ready JSON (order_id, amount, currency, key_id)
 *
 * Out of scope for this phase:
 * - Payment verification
 * - Saving razorpay_payment_id / razorpay_signature / payment_date
 * - Frontend Checkout
 */

import Razorpay from "razorpay";
import { sql } from "../../lib/db.js";

/**
 * Server-side pricing (never trust frontend amounts).
 *
 * PRODUCT_PRICE  — selling price per unit (₹2,499)
 * COUPON_CODE    — only valid coupon today
 * COUPON_DISCOUNT — flat ₹500 off per unit when coupon applies
 *
 * Final unit price:
 *   SAVE500 → 2499 - 500 = 1999
 *   otherwise → 2499
 *
 * To change the product price later: update PRODUCT_PRICE.
 * To add more coupons later: expand into a map, e.g.
 *   const COUPONS = { SAVE500: 500, SAVE1000: 1000 };
 *   then look up discount by coupon_code.
 */
const PRODUCT_PRICE = 2499;
const COUPON_CODE = "SAVE500";
const COUPON_DISCOUNT = 500;

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

/** Basic email format check. */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Validate and normalize the create-order payload.
 *
 * Prices are NEVER accepted from the client — they are calculated server-side.
 * Returns { data } on success or { error } with a clear 400 message.
 */
function validateCreatePaymentOrder(body) {
  if (!body || typeof body !== "object") {
    return { error: "Invalid JSON body" };
  }

  const customer_name = trimStr(body.customer_name);
  const phone = trimStr(body.phone);
  const email = trimStr(body.email);
  const address = trimStr(body.address);
  const city = trimStr(body.city);
  const state = trimStr(body.state);
  const pincode = trimStr(body.pincode);
  const quantity = Number(body.quantity);
  // Optional coupon — normalize to uppercase for case-insensitive match
  const coupon_code =
    body.coupon_code !== undefined && body.coupon_code !== null && body.coupon_code !== ""
      ? String(trimStr(body.coupon_code)).toUpperCase()
      : null;

  // --- Required field checks ---
  if (!customer_name) {
    return { error: "customer_name is required" };
  }
  if (!phone) {
    return { error: "phone is required" };
  }
  if (!/^\d{10}$/.test(String(phone))) {
    return { error: "phone must contain exactly 10 digits" };
  }
  if (!email) {
    return { error: "email is required" };
  }
  if (!isValidEmail(String(email))) {
    return { error: "email must be a valid email address" };
  }
  if (!address) {
    return { error: "address is required" };
  }
  if (!city) {
    return { error: "city is required" };
  }
  if (!state) {
    return { error: "state is required" };
  }
  if (!pincode) {
    return { error: "pincode is required" };
  }
  if (!/^\d{6}$/.test(String(pincode))) {
    return { error: "pincode must contain exactly 6 digits" };
  }
  if (body.quantity === undefined || body.quantity === null || body.quantity === "") {
    return { error: "quantity is required" };
  }
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
    return { error: "quantity must be an integer greater than 0" };
  }

  // --- Server-side pricing (ignore any client-sent unit_price / total_amount) ---
  // With SAVE500 → ₹1,999 per unit; otherwise → ₹2,499 per unit
  const unit_price =
    coupon_code === COUPON_CODE
      ? PRODUCT_PRICE - COUPON_DISCOUNT
      : PRODUCT_PRICE;
  const total_amount = unit_price * quantity;

  return {
    data: {
      customer_name,
      phone: String(phone),
      email: String(email).toLowerCase(),
      address,
      city,
      state,
      pincode: String(pincode),
      quantity,
      coupon_code,
      unit_price,
      total_amount,
    },
  };
}

/**
 * Build a Razorpay client from environment variables only.
 * Never hardcode key_id or key_secret.
 */
function getRazorpayClient() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    throw new Error(
      "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be configured"
    );
  }

  return new Razorpay({
    key_id,
    key_secret,
  });
}

/**
 * Generate a unique Razorpay receipt id (max 40 characters).
 * Format: taq_<timestamp36>_<random>
 */
function generateReceipt() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `taq_${ts}_${rand}`.slice(0, 40);
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Only POST is allowed for creating a Razorpay order
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

    // Step 1: Validate required fields
    const validation = validateCreatePaymentOrder(body);
    if (validation.error) {
      return json(res, 400, {
        success: false,
        message: validation.error,
      });
    }

    const orderData = validation.data;

    // Step 2: Convert INR total to paise (Razorpay's required unit)
    // Example: ₹2,499 × 1 → 249900 paise; ₹1,999 × 2 → 399800 paise
    const amountInPaise = Math.round(orderData.total_amount * 100);
    const receipt = generateReceipt();

    // Step 3: Create Razorpay Order via the official SDK
    const razorpay = getRazorpayClient();
    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt,
      notes: {
        customer_name: orderData.customer_name,
        phone: orderData.phone,
        email: orderData.email,
        quantity: String(orderData.quantity),
        coupon_code: orderData.coupon_code || "",
        unit_price: String(orderData.unit_price),
      },
    });

    // Step 4: Persist the order in Neon BEFORE payment completes
    // payment_status = Pending — payment_id / signature / payment_date stay null
    const { rows: inserted } = await sql`
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
        order_status,
        razorpay_order_id
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
        'Razorpay',
        'Pending',
        'New',
        ${razorpayOrder.id}
      )
      RETURNING id
    `;

    const dbOrderId = inserted[0].id;

    // Step 5: Assign human-readable order_number (TAQ-000001)
    const orderNumber = `TAQ-${String(dbOrderId).padStart(6, "0")}`;
    await sql`
      UPDATE orders
      SET order_number = ${orderNumber},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${dbOrderId}
    `;

    // Step 6: Return Checkout-ready payload
    // key_id is the public Razorpay key — safe to send to the client
    return json(res, 201, {
      success: true,
      order_id: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Payment create-order error:", error);

    // Prefer Razorpay's description when the SDK fails
    const razorpayMessage =
      error?.error?.description ||
      error?.description ||
      error?.message;

    return json(res, 500, {
      success: false,
      message: razorpayMessage || "Internal server error",
    });
  }
}
