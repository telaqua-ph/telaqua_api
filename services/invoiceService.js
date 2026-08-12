/**
 * services/invoiceService.js
 *
 * Idempotent Swipe invoice creation after paid orders.
 * Replaces the older Interakt + custom PDF generation flow.
 */

import { query } from "../config/db.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";
import {
  createSwipeInvoiceForOrder,
  getSwipeInvoiceDetails,
  getSwipeInvoicePdf,
} from "./swipeService.js";

const ORDER_SELECT = `
  SELECT
    id,
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
    order_number,
    razorpay_order_id,
    razorpay_payment_id,
    payment_date,
    promo_code,
    original_amount,
    discount_amount,
    COALESCE(is_test_order, FALSE) AS is_test_order,
    invoice_number,
    invoice_url,
    invoice_generated_at,
    invoice_status,
    whatsapp_invoice_status,
    whatsapp_invoice_message_id,
    whatsapp_invoice_sent_at,
    whatsapp_invoice_error,
    whatsapp_updates_consent,
    whatsapp_consent_at,
    swipe_invoice_id
  FROM orders
  WHERE id = $1
  LIMIT 1
`;

/**
 * @param {number} orderId
 * @returns {Promise<object|null>}
 */
export async function loadOrderForFulfillment(orderId) {
  const { rows } = await query(ORDER_SELECT, [orderId]);
  return rows[0] || null;
}

/**
 * @param {number|string} value
 */
function round2(value) {
  const n = Number(value);
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatDateDdMmYyyy(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function normalizeState(state) {
  return String(state || "").trim().toUpperCase() || "";
}

function buildStablePartyId(order) {
  const phone = String(order.phone || "").replace(/\D/g, "");
  if (phone) return `TAQ-CUST-PHONE-${phone}`;

  const email = String(order.email || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (email) return `TAQ-CUST-EMAIL-${email}`;

  return `TAQ-ORDER-${order.id}`;
}

function buildAddressPayload(order) {
  const addrId = `order-${order.id}-addr`;
  return {
    addr_id: 1,
    addr_id_v2: addrId,
    address_line1: String(order.address || "").slice(0, 200),
    address_line2: "",
    city: String(order.city || ""),
    state: normalizeState(order.state),
    country: "India",
    pincode: String(order.pincode || ""),
  };
}

function buildPartyPayload(order) {
  const phone = normalizeIndianPhone(order.phone);
  const party = {
    id: buildStablePartyId(order),
    type: "customer",
    name: String(order.customer_name || `Order ${order.id}`),
    email: order.email || undefined,
    billing_address: buildAddressPayload(order),
    shipping_address: buildAddressPayload(order),
  };

  if (!phone.error) {
    party.country_code = "91";
    party.phone_number = phone.phoneNumber;
  }

  return party;
}

function buildSwipeItem(order) {
  const qty = Math.max(1, Number(order.quantity) || 1);
  const totalInclusive = round2(order.total_amount);
  const totalExclusive = round2(totalInclusive / 1.18);
  const unitInclusive = round2(totalInclusive / qty);
  const unitExclusive = round2(totalExclusive / qty);

  return {
    id: String(process.env.SWIPE_PRODUCT_ID || "9027"),
    name: process.env.TELAQUA_PRODUCT_NAME || "Tel-Aqua PH Meter",
    quantity: qty,
    unit_price: unitExclusive,
    tax_rate: 18,
    price_with_tax: unitInclusive,
    net_amount: totalExclusive,
    total_amount: totalInclusive,
    item_type: "Product",
    unit: "UNT",
    hsn_code: "9027",
  };
}

function buildSwipePayload(order) {
  const item = buildSwipeItem(order);
  const consented = Boolean(order.whatsapp_updates_consent);
  const phone = normalizeIndianPhone(order.phone);
  const sendWtsp = consented && !phone.error && !order.is_test_order;

  return {
    document_type: "invoice",
    document_date: formatDateDdMmYyyy(new Date()),
    party: buildPartyPayload(order),
    items: [item],
    payments: [
      {
        amount: round2(order.total_amount),
        method: String(order.payment_method || "Razorpay").toLowerCase(),
        notes: order.razorpay_payment_id || order.razorpay_order_id || "",
      },
    ],
    reference:
      order.order_number || `TAQ-${String(order.id).padStart(6, "0")}`,
    notes: order.promo_code
      ? `Promo code applied: ${order.promo_code}`
      : undefined,
    send_wtsp: sendWtsp,
    send_sms: false,
  };
}

function buildStoredInvoiceUrl(order) {
  const paymentId = String(order.razorpay_payment_id || "").trim();
  if (!paymentId) return null;

  const relativePath =
    `/api/payment/invoice-download?order_id=${encodeURIComponent(order.id)}` +
    `&razorpay_payment_id=${encodeURIComponent(paymentId)}`;

  const base = (process.env.BACKEND_BASE_URL || "").trim().replace(/\/$/, "");
  if (!base) {
    return relativePath;
  }
  return `${base}${relativePath}`;
}

function buildWhatsAppStatusForCreatedInvoice(order) {
  if (order.is_test_order) {
    return {
      status: "not_applicable",
      messageId: null,
      sentAt: null,
      error: "Test order — WhatsApp not applicable",
    };
  }

  if (!order.whatsapp_updates_consent) {
    return {
      status: "not_applicable",
      messageId: null,
      sentAt: null,
      error: null,
    };
  }

  const phone = normalizeIndianPhone(order.phone);
  if (phone.error) {
    return {
      status: "failed",
      messageId: null,
      sentAt: null,
      error: phone.error,
    };
  }

  // Swipe supports send_wtsp on document creation, but current public docs
  // do not expose a separate message-status API. Keep status conservative.
  return {
    status: "pending",
    messageId: null,
    sentAt: null,
    error: null,
  };
}

/**
 * Ensure Swipe invoice exists and DB fields are set. Idempotent.
 * @param {object} order
 * @returns {Promise<{ invoice_number: string|null, invoice_url: string|null, invoice_generated_at: Date|null, swipe_invoice_id: string|null, created: boolean }>}
 */
async function ensureInvoiceGenerated(order) {
  if (
    order.swipe_invoice_id ||
    (order.invoice_number && String(order.invoice_status || "") === "generated")
  ) {
    console.log("Invoice reuse:", order.invoice_number || order.swipe_invoice_id);
    return {
      invoice_number: order.invoice_number || null,
      invoice_url: order.invoice_url,
      invoice_generated_at: order.invoice_generated_at,
      swipe_invoice_id: order.swipe_invoice_id || null,
      created: false,
    };
  }

  console.log("Swipe invoice generation started for order", order.id);
  const payload = buildSwipePayload(order);
  let created;

  try {
    created = await createSwipeInvoiceForOrder(order, payload);
  } catch (err) {
    console.error("Swipe invoice creation failure:", {
      orderId: order.id,
      message: err?.message,
      statusCode: err?.statusCode,
    });
    await query(
      `UPDATE orders
       SET invoice_status = 'failed',
           whatsapp_invoice_status = CASE
             WHEN whatsapp_invoice_status = 'sent' THEN whatsapp_invoice_status
             ELSE 'failed'
           END,
           whatsapp_invoice_error = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [order.id, String(err?.message || "Swipe invoice creation failed").slice(0, 500)]
    ).catch(() => {});
    throw new Error("Swipe invoice creation failed");
  }

  let hashId = created?.data?.hash_id ? String(created.data.hash_id) : null;
  let serialNumber = created?.data?.serial_number
    ? String(created.data.serial_number)
    : null;

  if (!hashId) {
    throw new Error("Swipe response missing hash_id");
  }

  if (!serialNumber) {
    try {
      const details = await getSwipeInvoiceDetails(hashId);
      serialNumber =
        details?.data?.invoice_details?.serial_number ||
        details?.data?.serial_number ||
        null;
    } catch (err) {
      console.warn("Swipe invoice details fetch failed:", {
        orderId: order.id,
        hashId,
        message: err?.message,
      });
    }
  }

  const publicUrl = buildStoredInvoiceUrl(order);
  const wtsp = buildWhatsAppStatusForCreatedInvoice(order);

  const { rows } = await query(
    `UPDATE orders
     SET
       invoice_number = $1,
       invoice_url = $2,
       invoice_generated_at = CURRENT_TIMESTAMP,
       invoice_status = 'generated',
       swipe_invoice_id = $3,
       whatsapp_invoice_status = CASE
         WHEN whatsapp_invoice_status = 'sent' THEN whatsapp_invoice_status
         ELSE $4
       END,
       whatsapp_invoice_message_id = CASE
         WHEN whatsapp_invoice_status = 'sent' THEN whatsapp_invoice_message_id
         ELSE $5
       END,
       whatsapp_invoice_sent_at = CASE
         WHEN whatsapp_invoice_status = 'sent' THEN whatsapp_invoice_sent_at
         ELSE $6
       END,
       whatsapp_invoice_error = CASE
         WHEN whatsapp_invoice_status = 'sent' THEN whatsapp_invoice_error
         ELSE $7
       END,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $8
       AND swipe_invoice_id IS NULL
       AND (invoice_status IS NULL OR invoice_status <> 'generated')
     RETURNING invoice_number, invoice_url, invoice_generated_at, swipe_invoice_id`,
    [
      serialNumber,
      publicUrl,
      hashId,
      wtsp.status,
      wtsp.messageId,
      wtsp.sentAt,
      wtsp.error,
      order.id,
    ]
  );

  if (rows.length > 0) {
    return {
      invoice_number: rows[0].invoice_number,
      invoice_url: rows[0].invoice_url,
      invoice_generated_at: rows[0].invoice_generated_at,
      swipe_invoice_id: rows[0].swipe_invoice_id,
      created: true,
    };
  }

  // Race: another request saved first
  const refreshed = await loadOrderForFulfillment(order.id);
  if (
    refreshed?.swipe_invoice_id ||
    (refreshed?.invoice_number &&
      String(refreshed?.invoice_status || "") === "generated")
  ) {
    return {
      invoice_number: refreshed.invoice_number || null,
      invoice_url: refreshed.invoice_url || null,
      invoice_generated_at: refreshed.invoice_generated_at || null,
      swipe_invoice_id: refreshed.swipe_invoice_id || null,
      created: false,
    };
  }

  throw new Error("Failed to save invoice to database");
}

/**
 * @param {number} orderId
 */
export async function getOrderInvoicePdfByOrderId(orderId) {
  const order = await loadOrderForFulfillment(orderId);
  if (!order) {
    const err = new Error("Order not found");
    err.statusCode = 404;
    throw err;
  }
  if (!order.swipe_invoice_id) {
    const err = new Error("Invoice is not generated yet");
    err.statusCode = 404;
    throw err;
  }
  return getSwipeInvoicePdf(order.swipe_invoice_id);
}

/**
 * Process invoice + WhatsApp for a paid order. Safe to call multiple times.
 * @param {number} orderId
 * @returns {Promise<object>}
 */
export async function processOrderFulfillment(orderId) {
  const order = await loadOrderForFulfillment(orderId);
  if (!order) {
    const err = new Error("Order not found");
    err.statusCode = 404;
    throw err;
  }

  if (String(order.payment_status).trim() !== "Paid") {
    const err = new Error("Order payment is not completed");
    err.statusCode = 400;
    throw err;
  }

  const invoice = await ensureInvoiceGenerated(order);
  const refreshed = await loadOrderForFulfillment(orderId);
  const whatsapp = {
    status: refreshed?.whatsapp_invoice_status || order.whatsapp_invoice_status || null,
    message_id:
      refreshed?.whatsapp_invoice_message_id ||
      order.whatsapp_invoice_message_id ||
      null,
    sent_at:
      refreshed?.whatsapp_invoice_sent_at ||
      order.whatsapp_invoice_sent_at ||
      null,
    error:
      refreshed?.whatsapp_invoice_error ||
      order.whatsapp_invoice_error ||
      null,
  };

  return {
    success: true,
    invoice: {
      invoice_number: invoice.invoice_number,
      invoice_url: invoice.invoice_url,
      invoice_generated_at: invoice.invoice_generated_at,
      swipe_invoice_id: invoice.swipe_invoice_id,
      created: invoice.created,
    },
    whatsapp: {
      status: whatsapp.status,
      message_id: whatsapp.message_id,
      sent_at: whatsapp.sent_at,
      error: whatsapp.error || null,
    },
  };
}
