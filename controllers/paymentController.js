/**
 * controllers/paymentController.js
 *
 * Razorpay create-order + verify-payment.
 * Optional promo_code is priced from promo_codes (never trust client prices).
 */

import crypto from "node:crypto";
import { query } from "../config/db.js";
import { getRazorpayClient } from "../config/razorpay.js";
import {
  normalizePromoCode,
  findActivePromoByCode,
  mapPromoPricing,
  incrementPromoUsedCount,
} from "../services/promoService.js";

/** Default product unit price when no promo is applied. */
const PRODUCT_PRICE = 2499;

function trimStr(value) {
  return typeof value === "string" ? value.trim() : value;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Validate customer fields for create-order (pricing resolved separately).
 * @param {object} body
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

  // Prefer promo_code; keep coupon_code as alias for older clients
  const promoRaw =
    body.promo_code !== undefined &&
    body.promo_code !== null &&
    body.promo_code !== ""
      ? body.promo_code
      : body.coupon_code !== undefined &&
          body.coupon_code !== null &&
          body.coupon_code !== ""
        ? body.coupon_code
        : null;

  const promo_code = promoRaw ? normalizePromoCode(promoRaw) : null;

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
      promo_code,
    },
  };
}

function generateReceipt() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `taq_${ts}_${rand}`.slice(0, 40);
}

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

  const generatedBuf = Buffer.from(generated, "utf8");
  const signatureBuf = Buffer.from(signature, "utf8");

  if (generatedBuf.length !== signatureBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(generatedBuf, signatureBuf);
}

/**
 * Resolve unit/total pricing from DB promo or default product price.
 * @param {{ quantity: number, promo_code: string|null }} orderData
 */
async function resolveOrderPricing(orderData) {
  const quantity = orderData.quantity;

  if (!orderData.promo_code) {
    const unit_price = PRODUCT_PRICE;
    return {
      promo_code: null,
      unit_price,
      original_amount: unit_price * quantity,
      discount_amount: 0,
      total_amount: unit_price * quantity,
    };
  }

  const row = await findActivePromoByCode(orderData.promo_code);
  if (!row) {
    return { error: "Invalid or inactive promo code" };
  }

  const promo = mapPromoPricing(row);
  if (
    !Number.isFinite(promo.original_price) ||
    !Number.isFinite(promo.promo_price) ||
    promo.promo_price <= 0 ||
    promo.original_price < promo.promo_price
  ) {
    return { error: "Promo pricing is invalid" };
  }

  const unit_price = promo.promo_price;
  const original_amount = promo.original_price * quantity;
  const total_amount = promo.promo_price * quantity;
  const discount_amount = original_amount - total_amount;

  return {
    promo_code: promo.code,
    unit_price,
    original_amount,
    discount_amount,
    total_amount,
  };
}

/** POST /api/payment/create-order */
export async function createPaymentOrder(req, res) {
  try {
    const body = req.body;
    if (body == null || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        message: "Invalid JSON body",
      });
    }

    const validation = validateCreatePaymentOrder(body);
    if (validation.error) {
      return res.status(400).json({
        success: false,
        message: validation.error,
      });
    }

    const orderData = validation.data;
    const pricing = await resolveOrderPricing(orderData);
    if (pricing.error) {
      return res.status(400).json({
        success: false,
        message: pricing.error,
      });
    }

    const amountInPaise = Math.round(pricing.total_amount * 100);
    const receipt = generateReceipt();

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
        promo_code: pricing.promo_code || "",
        unit_price: String(pricing.unit_price),
        original_amount: String(pricing.original_amount),
        discount_amount: String(pricing.discount_amount),
      },
    });

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
        razorpay_order_id,
        promo_code,
        original_amount,
        discount_amount
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        'Razorpay', 'Pending', 'New', $11, $12, $13, $14
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
        pricing.unit_price,
        pricing.total_amount,
        razorpayOrder.id,
        pricing.promo_code,
        pricing.original_amount,
        pricing.discount_amount,
      ]
    );

    const dbOrderId = inserted[0].id;
    const orderNumber = `TAQ-${String(dbOrderId).padStart(6, "0")}`;

    await query(
      `UPDATE orders
       SET order_number = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [orderNumber, dbOrderId]
    );

    return res.status(201).json({
      success: true,
      order_id: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
      promo_code: pricing.promo_code,
      original_amount: pricing.original_amount,
      discount_amount: pricing.discount_amount,
      total_amount: pricing.total_amount,
    });
  } catch (error) {
    console.error("Payment create-order error:", error);

    // Missing promo columns would surface as a DB error — return clear message
    if (
      error?.code === "42703" ||
      String(error?.message || "").includes("promo_code") ||
      String(error?.message || "").includes("original_amount") ||
      String(error?.message || "").includes("discount_amount")
    ) {
      return res.status(500).json({
        success: false,
        message:
          "Orders table is missing promo columns. Run the promo ALTER TABLE migration.",
      });
    }

    const razorpayMessage =
      error?.error?.description ||
      error?.description ||
      error?.message;

    return res.status(500).json({
      success: false,
      message: razorpayMessage || "Internal server error",
    });
  }
}

/** POST /api/payment/verify-payment */
export async function verifyPayment(req, res) {
  try {
    const body = req.body;
    if (body == null || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        message: "Invalid JSON body",
      });
    }

    const validation = validateVerifyPayload(body);
    if (validation.error) {
      return res.status(400).json({
        success: false,
        message: validation.error,
      });
    }

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = validation.data;

    const valid = isValidRazorpaySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );

    if (!valid) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment signature.",
      });
    }

    // Only transition Pending → Paid once (prevents double used_count increment)
    const { rows } = await query(
      `UPDATE orders
       SET
         payment_status = 'Paid',
         order_status = 'Confirmed',
         razorpay_payment_id = $1,
         razorpay_signature = $2,
         payment_date = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       WHERE razorpay_order_id = $3
         AND payment_status = 'Pending'
       RETURNING id, promo_code, original_amount, discount_amount, total_amount`,
      [razorpay_payment_id, razorpay_signature, razorpay_order_id]
    );

    if (rows.length === 0) {
      // Already paid or missing — check existence without changing promo fields
      const existing = await query(
        `SELECT id, payment_status, promo_code, original_amount, discount_amount, total_amount
         FROM orders
         WHERE razorpay_order_id = $1
         LIMIT 1`,
        [razorpay_order_id]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Order not found",
        });
      }

      if (existing.rows[0].payment_status === "Paid") {
        return res.status(200).json({
          success: true,
          message: "Payment verified successfully.",
        });
      }

      return res.status(400).json({
        success: false,
        message: "Order is not eligible for payment verification",
      });
    }

    const order = rows[0];

    // Increment promo usage only after successful verification (once)
    if (order.promo_code) {
      const incremented = await incrementPromoUsedCount(order.promo_code);
      if (!incremented) {
        console.warn(
          "Promo used_count was not incremented (inactive/limit/missing):",
          order.promo_code
        );
      }
    }

    return res.status(200).json({
      success: true,
      message: "Payment verified successfully.",
    });
  } catch (error) {
    console.error("Payment verify-payment error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}
