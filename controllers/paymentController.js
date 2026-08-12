/**
 * controllers/paymentController.js
 *
 * Razorpay create-order + verify-payment (PH meter).
 * Isolated ₹1 LIVE test: create-test-order (reuses same Razorpay client + verify).
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
import {
  ensureWhatsappConsentColumns,
  parseWhatsappConsent,
} from "../services/whatsappConsent.js";
import {
  getOrderInvoicePdfByOrderId,
  loadOrderForFulfillment,
  processOrderFulfillment,
} from "../services/invoiceService.js";

/** Default PH meter unit price when no promo is applied. */
const PRODUCT_PRICE = 2499;

/** Hidden LIVE test product — amount enforced only on the server (paise). */
const TEST_PRODUCT_NAME = "Tel-Aqua Razorpay Live Test Product";
const TEST_AMOUNT_RUPEES = 1;
const TEST_AMOUNT_PAISE = 100;

let isTestOrderColumnReady = false;

function trimStr(value) {
  return typeof value === "string" ? value.trim() : value;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Ensure is_test_order exists (idempotent). Used only by the test-order path.
 */
async function ensureIsTestOrderColumn() {
  if (isTestOrderColumnReady) return;
  await query(
    `ALTER TABLE orders
     ADD COLUMN IF NOT EXISTS is_test_order BOOLEAN NOT NULL DEFAULT FALSE`
  );
  isTestOrderColumnReady = true;
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

  const consent = parseWhatsappConsent(body);
  if (consent.error) {
    return { error: consent.error };
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
      whatsapp_updates_consent: consent.whatsapp_updates_consent,
      whatsapp_consent_at: consent.whatsapp_consent_at,
    },
  };
}

/**
 * Customer fields for the ₹1 LIVE test product.
 * Quantity is always forced to 1; amount/price from the client are ignored.
 * @param {object} body
 */
function validateCreateTestPaymentOrder(body) {
  if (!body || typeof body !== "object") {
    return { error: "Invalid JSON body" };
  }

  const customer_name = trimStr(body.customer_name);
  const phone = trimStr(body.phone);
  const email = trimStr(body.email);
  const address = trimStr(body.address) || "TEST ORDER";
  const city = trimStr(body.city) || "TEST";
  const state = trimStr(body.state) || "TEST";
  const pincode = trimStr(body.pincode) || "000000";

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
  if (pincode !== "000000" && !/^\d{6}$/.test(String(pincode))) {
    return { error: "pincode must contain exactly 6 digits" };
  }

  // Reject client attempts to override the fixed ₹1 amount
  if (body.amount !== undefined || body.total_amount !== undefined || body.unit_price !== undefined) {
    const claimed =
      body.amount !== undefined
        ? body.amount
        : body.total_amount !== undefined
          ? body.total_amount
          : body.unit_price;
    const claimedNum = Number(claimed);
    // Allow only if they claim ₹1 or 100 paise; otherwise reject
    if (
      Number.isFinite(claimedNum) &&
      claimedNum !== TEST_AMOUNT_RUPEES &&
      claimedNum !== TEST_AMOUNT_PAISE
    ) {
      return {
        error: "Invalid amount. Test product amount is fixed at ₹1 by the server.",
      };
    }
  }

  return {
    data: {
      customer_name,
      phone: String(phone),
      email: String(email).toLowerCase(),
      address: String(address),
      city: String(city),
      state: String(state),
      pincode: String(pincode),
      quantity: 1,
    },
  };
}

function generateReceipt(prefix = "taq") {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`.slice(0, 40);
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

function maskId(id) {
  const s = String(id || "");
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function buildVerifySuccessResponse(order, message) {
  const isTest = Boolean(order.is_test_order);
  return {
    success: true,
    message:
      message ||
      (isTest
        ? "₹1 test payment verified successfully"
        : "Payment verified successfully."),
    order_id: order.id,
    order_number: order.order_number,
    razorpay_order_id: order.razorpay_order_id,
    razorpay_payment_id: order.razorpay_payment_id,
    payment_status: order.payment_status || "Paid",
    is_test_order: isTest,
  };
}

/** Invoice + WhatsApp after Paid — non-blocking; never fails payment response. */
function triggerOrderFulfillmentAsync(orderId) {
  if (!orderId) return;
  processOrderFulfillment(orderId).catch((err) => {
    console.error("Order fulfillment failed:", {
      orderId,
      message: err?.message || String(err),
    });
  });
}

function parsePositiveOrderId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  return id;
}

function validateInvoiceStatusPayload(body) {
  if (!body || typeof body !== "object") {
    return { error: "Invalid JSON body" };
  }

  const order_id = parsePositiveOrderId(body.order_id);
  const razorpay_payment_id = trimStr(body.razorpay_payment_id);

  if (!order_id) {
    return { error: "order_id must be a positive integer" };
  }
  if (!razorpay_payment_id) {
    return { error: "razorpay_payment_id is required" };
  }

  return {
    data: {
      order_id,
      razorpay_payment_id: String(razorpay_payment_id),
    },
  };
}

/** POST /api/payment/invoice-status */
export async function getInvoiceStatus(req, res) {
  try {
    const validation = validateInvoiceStatusPayload(req.body);
    if (validation.error) {
      return res.status(400).json({
        success: false,
        message: validation.error,
      });
    }

    const { order_id, razorpay_payment_id } = validation.data;
    const order = await loadOrderForFulfillment(order_id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    if (String(order.razorpay_payment_id || "") !== razorpay_payment_id) {
      return res.status(403).json({
        success: false,
        message: "Payment does not match this order",
      });
    }

    if (String(order.payment_status || "").trim() !== "Paid") {
      return res.status(400).json({
        success: false,
        message: "Invoice is available only for paid orders",
      });
    }

    if (
      order.swipe_invoice_id ||
      (order.invoice_number &&
        String(order.invoice_status || "").trim() === "generated")
    ) {
      return res.status(200).json({
        success: true,
        invoice_ready: true,
        invoice_number: order.invoice_number,
        invoice_url: order.invoice_url,
        invoice_generated_at: order.invoice_generated_at,
      });
    }

    triggerOrderFulfillmentAsync(order.id);

    return res.status(200).json({
      success: true,
      invoice_ready: false,
      message: "Invoice is being generated",
    });
  } catch (error) {
    console.error("Payment invoice-status error:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

/** GET /api/payment/invoice-download?order_id=&razorpay_payment_id= */
export async function downloadCustomerInvoice(req, res) {
  try {
    const order_id = parsePositiveOrderId(req.query.order_id);
    const razorpay_payment_id = trimStr(req.query.razorpay_payment_id);

    if (!order_id) {
      return res.status(400).json({
        success: false,
        message: "order_id must be a positive integer",
      });
    }
    if (!razorpay_payment_id) {
      return res.status(400).json({
        success: false,
        message: "razorpay_payment_id is required",
      });
    }

    const order = await loadOrderForFulfillment(order_id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }
    if (String(order.razorpay_payment_id || "") !== razorpay_payment_id) {
      return res.status(403).json({
        success: false,
        message: "Payment does not match this order",
      });
    }
    if (String(order.payment_status || "").trim() !== "Paid") {
      return res.status(400).json({
        success: false,
        message: "Invoice is available only for paid orders",
      });
    }
    if (!order.swipe_invoice_id) {
      triggerOrderFulfillmentAsync(order.id);
      return res.status(404).json({
        success: false,
        message: "Invoice is not generated yet",
      });
    }

    const pdf = await getOrderInvoicePdfByOrderId(order.id);
    const invoiceNumber =
      order.invoice_number || `invoice-order-${String(order.id)}`;

    res.setHeader("Content-Type", pdf.contentType || "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${invoiceNumber}.pdf"`
    );
    return res.status(200).send(pdf.buffer);
  } catch (error) {
    console.error("Payment invoice-download error:", error?.message || error);
    const status = error?.statusCode || 500;
    if (status === 404) {
      return res.status(404).json({
        success: false,
        message: error.message || "Invoice not found",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Failed to download invoice",
    });
  }
}

/**
 * Confirm Razorpay order/payment amounts match the internal order (paise).
 * For test orders, expected amount is always 100 paise.
 */
async function assertRazorpayAmountMatches(order, razorpay_order_id, razorpay_payment_id) {
  const expectedPaise = order.is_test_order
    ? TEST_AMOUNT_PAISE
    : Math.round(Number(order.total_amount) * 100);

  if (!Number.isFinite(expectedPaise) || expectedPaise <= 0) {
    return { error: "Internal order amount is invalid" };
  }

  if (order.is_test_order) {
    const dbRupees = Number(order.total_amount);
    if (dbRupees !== TEST_AMOUNT_RUPEES) {
      return {
        error: "Test order amount mismatch in database. Expected ₹1.",
      };
    }
  }

  const razorpay = getRazorpayClient();

  let rzOrder;
  let rzPayment;
  try {
    rzOrder = await razorpay.orders.fetch(razorpay_order_id);
  } catch (err) {
    console.error(
      "Razorpay order fetch failed:",
      maskId(razorpay_order_id),
      err?.error?.description || err?.message
    );
    return { error: "Failed to fetch Razorpay order for amount verification" };
  }

  try {
    rzPayment = await razorpay.payments.fetch(razorpay_payment_id);
  } catch (err) {
    console.error(
      "Razorpay payment fetch failed:",
      maskId(razorpay_payment_id),
      err?.error?.description || err?.message
    );
    return { error: "Failed to fetch Razorpay payment for amount verification" };
  }

  const orderAmount = Number(rzOrder.amount);
  const paymentAmount = Number(rzPayment.amount);

  if (orderAmount !== expectedPaise) {
    console.warn(
      "Razorpay order amount mismatch:",
      maskId(razorpay_order_id),
      "expected",
      expectedPaise,
      "got",
      orderAmount
    );
    return {
      error: order.is_test_order
        ? "Payment amount mismatch. Expected ₹1 (100 paise)."
        : "Payment amount does not match order amount.",
    };
  }

  if (paymentAmount !== expectedPaise) {
    console.warn(
      "Razorpay payment amount mismatch:",
      maskId(razorpay_payment_id),
      "expected",
      expectedPaise,
      "got",
      paymentAmount
    );
    return {
      error: order.is_test_order
        ? "Payment amount mismatch. Expected ₹1 (100 paise)."
        : "Payment amount does not match order amount.",
    };
  }

  if (rzPayment.order_id && rzPayment.order_id !== razorpay_order_id) {
    return { error: "Payment does not belong to this Razorpay order" };
  }

  return { ok: true, expectedPaise };
}

/** POST /api/payment/create-order — PH meter (unchanged pricing) */
export async function createPaymentOrder(req, res) {
  try {
    const body = req.body;
    if (body == null || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        message: "Invalid JSON body",
      });
    }

    // Do not allow the normal checkout path to become a ₹1 test order
    if (body.is_test_order === true || body.is_razorpay_test === true) {
      return res.status(400).json({
        success: false,
        message:
          "Use POST /api/payment/create-test-order for the ₹1 LIVE test product",
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

    const amountInPaise = Math.round(pricing.total_amount * 100);
    const receipt = generateReceipt("taq");

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
        discount_amount,
        whatsapp_updates_consent,
        whatsapp_consent_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        'Razorpay', 'Pending', 'New', $11, $12, $13, $14, $15, $16
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
        orderData.whatsapp_updates_consent,
        orderData.whatsapp_consent_at,
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

/**
 * POST /api/payment/create-test-order
 * Hidden ₹1 LIVE Razorpay test — reuses getRazorpayClient + orders table.
 * Never trusts client amount; always creates order for 100 paise.
 */
export async function createTestPaymentOrder(req, res) {
  try {
    console.log("TEST ORDER REQUEST: create-test-order");

    const body = req.body;
    if (body == null || typeof body !== "object") {
      return res.status(400).json({
        success: false,
        message: "Invalid JSON body",
      });
    }

    const validation = validateCreateTestPaymentOrder(body);
    if (validation.error) {
      console.warn("TEST ORDER REQUEST rejected:", validation.error);
      return res.status(400).json({
        success: false,
        message: validation.error,
      });
    }

    const orderData = validation.data;

    try {
      await ensureIsTestOrderColumn();
    } catch (colErr) {
      console.error("TEST ORDER: failed to ensure is_test_order column:", colErr?.message);
      return res.status(500).json({
        success: false,
        message:
          "Database is missing is_test_order. Run sql/add_is_test_order.sql",
      });
    }

    // Server-enforced pricing — ignore any client amount
    const unit_price = TEST_AMOUNT_RUPEES;
    const total_amount = TEST_AMOUNT_RUPEES;
    const amountInPaise = TEST_AMOUNT_PAISE;
    const receipt = generateReceipt("test");

    const razorpay = getRazorpayClient();
    let razorpayOrder;
    try {
      razorpayOrder = await razorpay.orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt,
        notes: {
          product: TEST_PRODUCT_NAME,
          is_test_order: "true",
          quantity: "1",
          unit_price: String(unit_price),
        },
      });
    } catch (rzErr) {
      console.error(
        "TEST ORDER: Razorpay order creation failure:",
        rzErr?.error?.description || rzErr?.message
      );
      return res.status(502).json({
        success: false,
        message:
          rzErr?.error?.description ||
          rzErr?.message ||
          "Razorpay order creation failed",
      });
    }

    console.log(
      "TEST ORDER: Razorpay order created",
      maskId(razorpayOrder.id),
      "amount_paise=",
      razorpayOrder.amount
    );

    if (Number(razorpayOrder.amount) !== TEST_AMOUNT_PAISE) {
      console.error(
        "TEST ORDER: unexpected Razorpay amount",
        razorpayOrder.amount
      );
      return res.status(500).json({
        success: false,
        message: "Razorpay returned unexpected amount for test order",
      });
    }

    let inserted;
    try {
      // Do not insert into `notes` — that column does not exist on production orders.
      const result = await query(
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
          discount_amount,
          is_test_order
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          'Razorpay', 'Pending', 'New', $11, NULL, $12, 0,
          TRUE
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
          1,
          unit_price,
          total_amount,
          razorpayOrder.id,
          total_amount,
        ]
      );
      inserted = result.rows;
    } catch (dbErr) {
      console.error("TEST ORDER: database insert failure:", {
        code: dbErr?.code,
        message: dbErr?.message,
        detail: dbErr?.detail,
        hint: dbErr?.hint,
        column: dbErr?.column,
        constraint: dbErr?.constraint,
        table: dbErr?.table,
        stack: dbErr?.stack,
      });
      // Temporary: expose real DB error while debugging create-test-order
      return res.status(500).json({
        success: false,
        message: "Failed to save test order",
        db_error: {
          code: dbErr?.code || null,
          message: dbErr?.message || String(dbErr),
          detail: dbErr?.detail || null,
          hint: dbErr?.hint || null,
          column: dbErr?.column || null,
          constraint: dbErr?.constraint || null,
        },
      });
    }

    const dbOrderId = inserted[0].id;
    const orderNumber = `TEST-${String(dbOrderId).padStart(6, "0")}`;

    await query(
      `UPDATE orders
       SET order_number = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [orderNumber, dbOrderId]
    );

    console.log(
      "TEST ORDER: database updated id=",
      dbOrderId,
      "order_number=",
      orderNumber,
      "razorpay_order_id=",
      maskId(razorpayOrder.id)
    );

    // Same public shape as create-order (key_id only — never secret)
    return res.status(201).json({
      success: true,
      order_id: razorpayOrder.id,
      db_order_id: dbOrderId,
      order_number: orderNumber,
      amount: TEST_AMOUNT_PAISE,
      currency: "INR",
      key_id: process.env.RAZORPAY_KEY_ID,
      product: TEST_PRODUCT_NAME,
      total_amount: TEST_AMOUNT_RUPEES,
      is_test_order: true,
    });
  } catch (error) {
    console.error("TEST ORDER create-test-order error:", error?.message);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
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

    // Load order first (needed for test-order logging + amount checks).
    // Falls back if is_test_order column is not migrated yet (PH meter still works).
    let orderRow;
    try {
      await ensureIsTestOrderColumn();
    } catch {
      /* ignore — SELECT may still succeed if column already exists */
    }

    let existingOrder;
    try {
      existingOrder = await query(
        `SELECT
           id,
           order_number,
           total_amount,
           payment_status,
           promo_code,
           original_amount,
           discount_amount,
           razorpay_order_id,
           razorpay_payment_id,
           COALESCE(is_test_order, FALSE) AS is_test_order
         FROM orders
         WHERE razorpay_order_id = $1
         LIMIT 1`,
        [razorpay_order_id]
      );
    } catch (selectErr) {
      if (
        selectErr?.code === "42703" ||
        String(selectErr?.message || "").includes("is_test_order")
      ) {
        existingOrder = await query(
          `SELECT
             id,
             order_number,
             total_amount,
             payment_status,
             promo_code,
             original_amount,
             discount_amount,
             razorpay_order_id,
             razorpay_payment_id,
             FALSE AS is_test_order
           FROM orders
           WHERE razorpay_order_id = $1
           LIMIT 1`,
          [razorpay_order_id]
        );
      } else {
        throw selectErr;
      }
    }

    if (existingOrder.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    orderRow = existingOrder.rows[0];
    const isTest = Boolean(orderRow.is_test_order);

    if (isTest) {
      console.log(
        "TEST ORDER: payment verification started",
        "order=",
        orderRow.order_number,
        "rz_order=",
        maskId(razorpay_order_id),
        "rz_payment=",
        maskId(razorpay_payment_id)
      );
    }

    // Idempotency: same payment already applied to a Paid order
    let byPayment;
    try {
      byPayment = await query(
        `SELECT
           id,
           order_number,
           payment_status,
           razorpay_order_id,
           razorpay_payment_id,
           COALESCE(is_test_order, FALSE) AS is_test_order
         FROM orders
         WHERE razorpay_payment_id = $1
           AND payment_status = 'Paid'
         LIMIT 1`,
        [razorpay_payment_id]
      );
    } catch (dupErr) {
      if (
        dupErr?.code === "42703" ||
        String(dupErr?.message || "").includes("is_test_order")
      ) {
        byPayment = await query(
          `SELECT
             id,
             order_number,
             payment_status,
             razorpay_order_id,
             razorpay_payment_id,
             FALSE AS is_test_order
           FROM orders
           WHERE razorpay_payment_id = $1
             AND payment_status = 'Paid'
           LIMIT 1`,
          [razorpay_payment_id]
        );
      } else {
        throw dupErr;
      }
    }

    if (byPayment.rows.length > 0) {
      const paid = byPayment.rows[0];
      if (isTest) {
        console.log(
          "TEST ORDER: duplicate payment ignored (already processed)",
          maskId(razorpay_payment_id)
        );
      }
      triggerOrderFulfillmentAsync(paid.id);
      return res.status(200).json(
        buildVerifySuccessResponse(
          paid,
          isTest || paid.is_test_order
            ? "₹1 test payment already verified"
            : "Payment already verified."
        )
      );
    }

    // Idempotency: order already Paid
    if (orderRow.payment_status === "Paid") {
      if (isTest) {
        console.log(
          "TEST ORDER: order already Paid",
          orderRow.order_number
        );
      }
      triggerOrderFulfillmentAsync(orderRow.id);
      return res.status(200).json(
        buildVerifySuccessResponse(
          {
            ...orderRow,
            razorpay_payment_id:
              orderRow.razorpay_payment_id || razorpay_payment_id,
          },
          isTest
            ? "₹1 test payment already verified"
            : "Payment verified successfully."
        )
      );
    }

    if (orderRow.payment_status !== "Pending") {
      return res.status(400).json({
        success: false,
        message: "Order is not eligible for payment verification",
      });
    }

    let valid;
    try {
      valid = isValidRazorpaySignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      );
    } catch (sigErr) {
      console.error("Payment signature config error:", sigErr?.message);
      return res.status(500).json({
        success: false,
        message: "Payment verification is not configured",
      });
    }

    if (!valid) {
      if (isTest) {
        console.warn(
          "TEST ORDER: payment verification failed (invalid signature)",
          maskId(razorpay_order_id)
        );
      }
      await query(
        `UPDATE orders
         SET updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND payment_status = 'Pending'`,
        [orderRow.id]
      ).catch(() => {});
      return res.status(400).json({
        success: false,
        message: "Invalid payment signature.",
      });
    }

    // Amount cross-check against Razorpay API only for the ₹1 LIVE test path
    // (keeps normal PH meter verify behavior signature-based as before).
    if (isTest) {
      const amountCheck = await assertRazorpayAmountMatches(
        orderRow,
        razorpay_order_id,
        razorpay_payment_id
      );

      if (amountCheck.error) {
        console.warn(
          "TEST ORDER: payment verification failed (amount)",
          amountCheck.error
        );
        await query(
          `UPDATE orders
           SET updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
             AND payment_status = 'Pending'`,
          [orderRow.id]
        ).catch(() => {});
        return res.status(400).json({
          success: false,
          message: amountCheck.error,
        });
      }
    }

    // Only transition Pending → Paid once (prevents double used_count increment)
    let rows;
    try {
      ({ rows } = await query(
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
         RETURNING
           id,
           order_number,
           promo_code,
           original_amount,
           discount_amount,
           total_amount,
           payment_status,
           razorpay_order_id,
           razorpay_payment_id,
           COALESCE(is_test_order, FALSE) AS is_test_order`,
        [razorpay_payment_id, razorpay_signature, razorpay_order_id]
      ));
    } catch (updErr) {
      if (
        updErr?.code === "42703" ||
        String(updErr?.message || "").includes("is_test_order")
      ) {
        ({ rows } = await query(
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
           RETURNING
             id,
             order_number,
             promo_code,
             original_amount,
             discount_amount,
             total_amount,
             payment_status,
             razorpay_order_id,
             razorpay_payment_id,
             FALSE AS is_test_order`,
          [razorpay_payment_id, razorpay_signature, razorpay_order_id]
        ));
      } else {
        throw updErr;
      }
    }

    if (rows.length === 0) {
      // Race: another request marked Paid
      let again;
      try {
        again = await query(
          `SELECT
             id,
             order_number,
             payment_status,
             razorpay_order_id,
             razorpay_payment_id,
             COALESCE(is_test_order, FALSE) AS is_test_order
           FROM orders
           WHERE razorpay_order_id = $1
           LIMIT 1`,
          [razorpay_order_id]
        );
      } catch {
        again = await query(
          `SELECT
             id,
             order_number,
             payment_status,
             razorpay_order_id,
             razorpay_payment_id,
             FALSE AS is_test_order
           FROM orders
           WHERE razorpay_order_id = $1
           LIMIT 1`,
          [razorpay_order_id]
        );
      }

      if (again.rows.length && again.rows[0].payment_status === "Paid") {
        triggerOrderFulfillmentAsync(again.rows[0].id);
        return res.status(200).json(
          buildVerifySuccessResponse(
            again.rows[0],
            again.rows[0].is_test_order
              ? "₹1 test payment already verified"
              : "Payment verified successfully."
          )
        );
      }

      return res.status(400).json({
        success: false,
        message: "Order is not eligible for payment verification",
      });
    }

    const order = rows[0];

    // Increment promo usage only after successful verification (once); never for test orders
    if (order.promo_code && !order.is_test_order) {
      const incremented = await incrementPromoUsedCount(order.promo_code);
      if (!incremented) {
        console.warn(
          "Promo used_count was not incremented (inactive/limit/missing):",
          order.promo_code
        );
      }
    }

    if (order.is_test_order) {
      console.log(
        "TEST ORDER: payment verification successful",
        "order=",
        order.order_number,
        "rz_payment=",
        maskId(order.razorpay_payment_id),
        "→ database updated Paid"
      );
    }

    triggerOrderFulfillmentAsync(order.id);

    return res.status(200).json(buildVerifySuccessResponse(order));
  } catch (error) {
    console.error("Payment verify-payment error:", error?.message || error);

    if (
      error?.code === "42703" ||
      String(error?.message || "").includes("is_test_order")
    ) {
      return res.status(500).json({
        success: false,
        message:
          "Orders table is missing is_test_order. Run sql/add_is_test_order.sql",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}
