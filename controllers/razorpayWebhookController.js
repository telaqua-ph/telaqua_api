/** Razorpay webhook: raw-body signature verification and idempotent payment updates. */

import crypto from "node:crypto";
import { pool } from "../config/db.js";
import { incrementPromoUsedCount } from "../services/promoService.js";
import { processOrderFulfillment } from "../services/invoiceService.js";

function validSignature(rawBody, received, secret) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(String(received || ""), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizeMethod(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  return {
    upi: "upi", card: "card", netbanking: "netbanking", wallet: "wallet",
    emi: "emi", paylater: "paylater",
  }[raw] || (raw || "razorpay");
}

function triggerInvoice(orderId) {
  processOrderFulfillment(orderId).catch((error) => {
    console.error("Webhook-triggered invoice failed", { orderId, message: error?.message });
  });
}

/** POST /api/webhooks/razorpay */
export async function handleRazorpayWebhook(req, res) {
  const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return res.status(503).json({ success: false, message: "Webhook is not configured" });
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
  const signature = req.headers["x-razorpay-signature"];
  if (!signature || !validSignature(rawBody, signature, secret)) {
    return res.status(401).json({ success: false, message: "Invalid webhook signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ success: false, message: "Invalid webhook payload" });
  }

  const eventType = String(event?.event || "");
  if (!["payment.captured", "order.paid", "payment.failed"].includes(eventType)) {
    return res.status(200).json({ success: true, ignored: true });
  }

  const payment = event?.payload?.payment?.entity || {};
  const razorpayOrderId = String(payment.order_id || event?.payload?.order?.entity?.id || "");
  const eventId = String(req.headers["x-razorpay-event-id"] ||
    `${eventType}:${payment.id || razorpayOrderId}:${payment.status || "unknown"}`);
  if (!razorpayOrderId) {
    return res.status(200).json({ success: true, ignored: true });
  }

  const client = await pool.connect();
  let paidOrder = null;
  try {
    await client.query("BEGIN");
    const duplicate = await client.query(
      `INSERT INTO razorpay_webhook_events (event_id, event_type)
       VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [eventId, eventType]
    );
    if (!duplicate.rows.length) {
      await client.query("ROLLBACK");
      return res.status(200).json({ success: true, duplicate: true });
    }

    const found = await client.query(
      `SELECT id, order_number, payment_status, promo_code,
              COALESCE(final_total, total_amount) AS expected_total
       FROM orders WHERE razorpay_order_id = $1 FOR UPDATE`,
      [razorpayOrderId]
    );
    if (!found.rows.length) {
      await client.query("COMMIT");
      return res.status(200).json({ success: true, ignored: true });
    }
    const order = found.rows[0];

    if (eventType === "payment.failed") {
      await client.query(
        `UPDATE orders SET payment_status = 'Failed', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND payment_status <> 'Paid'`,
        [order.id]
      );
      await client.query("COMMIT");
      return res.status(200).json({ success: true });
    }

    const expectedPaise = Math.round(Number(order.expected_total) * 100);
    const captured = String(payment.status || "").toLowerCase() === "captured";
    const validPayment = captured && Number(payment.amount) === expectedPaise &&
      String(payment.currency || "").toUpperCase() === "INR" && payment.id;
    if (!validPayment) {
      console.warn("Razorpay webhook payment mismatch", { orderId: order.id, eventType });
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "Payment details do not match order" });
    }

    const updated = await client.query(
      `UPDATE orders SET payment_status = 'Paid', order_status = 'Confirmed',
         razorpay_payment_id = $2, payment_method = $3,
         payment_date = COALESCE(payment_date, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND payment_status <> 'Paid'
       RETURNING id, order_number, promo_code`,
      [order.id, String(payment.id), normalizeMethod(payment.method)]
    );
    paidOrder = updated.rows[0]
      ? { ...updated.rows[0], newlyPaid: true }
      : (order.payment_status === "Paid" ? { ...order, newlyPaid: false } : null);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Razorpay webhook processing failed", { eventType, message: error?.message });
    return res.status(500).json({ success: false, message: "Webhook processing failed" });
  } finally {
    client.release();
  }

  if (paidOrder) {
    if (paidOrder.newlyPaid && paidOrder.promo_code) {
      await incrementPromoUsedCount(paidOrder.promo_code).catch(() => {});
    }
    console.log(`Razorpay payment verified for ${paidOrder.order_number || paidOrder.id}`);
    triggerInvoice(paidOrder.id);
  }
  return res.status(200).json({ success: true });
}
