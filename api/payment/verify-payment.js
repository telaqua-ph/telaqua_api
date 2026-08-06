/**
 * api/payment/verify-payment.js
 *
 * POST /api/payment/verify-payment
 *
 * Secure Razorpay payment verification:
 * 1. Validate razorpay_order_id, razorpay_payment_id, razorpay_signature
 * 2. Recompute HMAC-SHA256 signature with RAZORPAY_KEY_SECRET
 * 3. If invalid → 400 (do not touch the database)
 * 4. If valid → mark the matching order as Paid / Confirmed
 *
 * Does NOT create Razorpay orders (see create-order.js).
 */

import crypto from "node:crypto";
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
 * Validate the verify-payment payload.
 * Returns { data } on success or { error } with a 400 message.
 */
function validateVerifyPayload(body) {
  if (!body || typeof body !== "object") {
    return { error: "Invalid JSON body" };
  }

  const razorpay_order_id = trimStr(body.razorpay_order_id);
  const razorpay_payment_id = trimStr(body.razorpay_payment_id);
  const razorpay_signature = trimStr(body.razorpay_signature);

  if (!razorpay_order_id) {
    return { error: "razorpay_order_id is required" };
  }
  if (!razorpay_payment_id) {
    return { error: "razorpay_payment_id is required" };
  }
  if (!razorpay_signature) {
    return { error: "razorpay_signature is required" };
  }

  return {
    data: {
      razorpay_order_id: String(razorpay_order_id),
      razorpay_payment_id: String(razorpay_payment_id),
      razorpay_signature: String(razorpay_signature),
    },
  };
}

/**
 * Official Razorpay signature verification.
 *
 * generated_signature = HMAC_SHA256(
 *   razorpay_order_id + "|" + razorpay_payment_id,
 *   RAZORPAY_KEY_SECRET
 * )
 *
 * Uses timing-safe comparison to avoid timing attacks.
 */
function isValidRazorpaySignature(orderId, paymentId, signature) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    throw new Error("RAZORPAY_KEY_SECRET must be configured");
  }

  const payload = `${orderId}|${paymentId}`;
  const generated = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  // timingSafeEqual requires equal-length buffers
  const generatedBuf = Buffer.from(generated, "utf8");
  const signatureBuf = Buffer.from(signature, "utf8");

  if (generatedBuf.length !== signatureBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(generatedBuf, signatureBuf);
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Only POST is allowed for payment verification
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

    // Step 1: Validate required Razorpay response fields
    const validation = validateVerifyPayload(body);
    if (validation.error) {
      return json(res, 400, {
        success: false,
        message: validation.error,
      });
    }

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = validation.data;

    // Step 2: Verify HMAC-SHA256 signature with the server secret
    // If invalid → do NOT update the database
    const valid = isValidRazorpaySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );

    if (!valid) {
      return json(res, 400, {
        success: false,
        message: "Invalid payment signature.",
      });
    }

    // Step 3: Signature is valid — mark the matching order as paid
    const { rows } = await sql`
      UPDATE orders
      SET
        payment_status = 'Paid',
        order_status = 'Confirmed',
        razorpay_payment_id = ${razorpay_payment_id},
        razorpay_signature = ${razorpay_signature},
        payment_date = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE razorpay_order_id = ${razorpay_order_id}
      RETURNING id
    `;

    // No matching pending order for this Razorpay order id
    if (rows.length === 0) {
      return json(res, 404, {
        success: false,
        message: "Order not found",
      });
    }

    // Step 4: Payment verified and order updated
    return json(res, 200, {
      success: true,
      message: "Payment verified successfully.",
    });
  } catch (error) {
    console.error("Payment verify-payment error:", error);
    return json(res, 500, {
      success: false,
      message: error?.message || "Internal server error",
    });
  }
}
