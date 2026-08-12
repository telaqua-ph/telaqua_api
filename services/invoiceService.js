/**
 * services/invoiceService.js
 *
 * Idempotent invoice generation + Interakt WhatsApp after paid orders.
 */

import fs from "node:fs";
import path from "node:path";
import { query } from "../config/db.js";
import { sendOrderInvoiceWhatsApp } from "./interaktService.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";
import {
  generateInvoicePdf,
  buildInvoiceNumber,
  invoiceNumberToFileName,
  getInvoicesStorageDir,
  buildInvoicePublicUrl,
} from "../utils/generateInvoicePdf.js";

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
    whatsapp_invoice_error
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
 * Ensure invoice PDF exists and DB fields are set. Idempotent.
 * @param {object} order
 * @returns {Promise<{ invoice_number: string, invoice_url: string, invoice_generated_at: Date|null, created: boolean }>}
 */
async function ensureInvoiceGenerated(order) {
  if (order.invoice_number && order.invoice_url) {
    console.log("Invoice reuse:", order.invoice_number);
    return {
      invoice_number: order.invoice_number,
      invoice_url: order.invoice_url,
      invoice_generated_at: order.invoice_generated_at,
      created: false,
    };
  }

  console.log("Invoice generation started for order", order.id);

  const invoiceNumber =
    order.invoice_number || buildInvoiceNumber(order.id);
  const fileName = invoiceNumberToFileName(invoiceNumber);
  const storageDir = getInvoicesStorageDir();
  const filePath = path.join(storageDir, fileName);

  let publicUrl;
  try {
    publicUrl = buildInvoicePublicUrl(fileName);
  } catch (err) {
    throw new Error(err.message || "Invoice public URL configuration error");
  }

  const orderForPdf = {
    ...order,
    invoice_generated_at: new Date(),
  };

  try {
    await generateInvoicePdf(orderForPdf, invoiceNumber, filePath);
    console.log("Invoice generated:", invoiceNumber);
  } catch (err) {
    console.error("Invoice generation failure:", err?.message);
    await query(
      `UPDATE orders
       SET invoice_status = 'failed',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [order.id]
    ).catch(() => {});
    throw new Error("Invoice PDF generation failed");
  }

  if (!fs.existsSync(filePath)) {
    throw new Error("Invoice PDF storage failed");
  }

  console.log("Invoice stored:", fileName);

  const { rows } = await query(
    `UPDATE orders
     SET
       invoice_number = $1,
       invoice_url = $2,
       invoice_generated_at = CURRENT_TIMESTAMP,
       invoice_status = 'generated',
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $3
       AND (invoice_url IS NULL OR invoice_url = '')
     RETURNING invoice_number, invoice_url, invoice_generated_at`,
    [invoiceNumber, publicUrl, order.id]
  );

  if (rows.length > 0) {
    return {
      invoice_number: rows[0].invoice_number,
      invoice_url: rows[0].invoice_url,
      invoice_generated_at: rows[0].invoice_generated_at,
      created: true,
    };
  }

  // Race: another request saved first
  const refreshed = await loadOrderForFulfillment(order.id);
  if (refreshed?.invoice_number && refreshed?.invoice_url) {
    return {
      invoice_number: refreshed.invoice_number,
      invoice_url: refreshed.invoice_url,
      invoice_generated_at: refreshed.invoice_generated_at,
      created: false,
    };
  }

  throw new Error("Failed to save invoice to database");
}

/**
 * Send WhatsApp invoice if not already sent. Idempotent for 'sent'.
 * @param {object} order
 * @param {{ invoice_number: string, invoice_url: string }} invoice
 */
async function ensureWhatsAppSent(order, invoice) {
  if (order.whatsapp_invoice_status === "sent") {
    console.log("WhatsApp already sent for order", order.id);
    return {
      status: "sent",
      message_id: order.whatsapp_invoice_message_id,
      sent_at: order.whatsapp_invoice_sent_at,
      skipped: true,
    };
  }

  if (order.is_test_order) {
    console.log("Skipping WhatsApp for test order", order.id);
    await query(
      `UPDATE orders
       SET whatsapp_invoice_status = 'skipped',
           whatsapp_invoice_error = 'Test order — WhatsApp not sent',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [order.id]
    ).catch(() => {});
    return {
      status: "skipped",
      message_id: null,
      sent_at: null,
      skipped: true,
    };
  }

  const phone = normalizeIndianPhone(order.phone);
  if (phone.error) {
    console.warn("WhatsApp skipped — invalid phone:", phone.error);
    await query(
      `UPDATE orders
       SET whatsapp_invoice_status = 'failed',
           whatsapp_invoice_error = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [phone.error, order.id]
    );
    return {
      status: "failed",
      message_id: null,
      sent_at: null,
      error: phone.error,
    };
  }

  const fileName = invoiceNumberToFileName(invoice.invoice_number);
  const orderLabel =
    order.order_number || `TAQ-${String(order.id).padStart(6, "0")}`;

  try {
    const result = await sendOrderInvoiceWhatsApp({
      countryCode: phone.countryCode,
      phoneNumber: phone.phoneNumber,
      customerName: order.customer_name,
      orderId: orderLabel,
      amount: order.total_amount,
      pdfUrl: invoice.invoice_url,
      fileName,
    });

    const messageId = result.messageId
      ? String(result.messageId)
      : null;

    await query(
      `UPDATE orders
       SET
         whatsapp_invoice_status = 'sent',
         whatsapp_invoice_message_id = $1,
         whatsapp_invoice_sent_at = CURRENT_TIMESTAMP,
         whatsapp_invoice_error = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [messageId, order.id]
    );

    return {
      status: "sent",
      message_id: messageId,
      sent_at: new Date().toISOString(),
      skipped: false,
    };
  } catch (err) {
    const safeError = String(err?.message || "WhatsApp delivery failed").slice(
      0,
      500
    );
    await query(
      `UPDATE orders
       SET
         whatsapp_invoice_status = 'failed',
         whatsapp_invoice_error = $1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [safeError, order.id]
    );
    return {
      status: "failed",
      message_id: null,
      sent_at: null,
      error: safeError,
    };
  }
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
  const whatsapp = await ensureWhatsAppSent(refreshed || order, invoice);

  return {
    success: true,
    invoice: {
      invoice_number: invoice.invoice_number,
      invoice_url: invoice.invoice_url,
      invoice_generated_at: invoice.invoice_generated_at,
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
