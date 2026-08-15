/**
 * Shared Razorpay payment confirmation against the existing orders row.
 * Used by verify-payment, webhook, and admin reconciliation. Never INSERTs a checkout order.
 */

import { pool, query } from "../config/db.js";
import { getRazorpayClient } from "../config/razorpay.js";
import { incrementPromoUsedCount } from "./promoService.js";
import { processOrderFulfillment } from "./invoiceService.js";

export function logPaymentEvent(code, extra = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    ...extra,
  };
  if (code === "ORDER_NOT_FOUND" || code === "DATABASE_UPDATE_FAILED" || code === "WEBHOOK_PROCESSING_FAILED") {
    console.error(code, payload);
    return;
  }
  console.log(code, payload);
}

export function triggerOrderFulfillmentAsync(orderId) {
  if (!orderId) return;
  processOrderFulfillment(orderId).catch((err) => {
    console.error("Order fulfillment failed:", {
      orderId,
      message: err?.message || String(err),
    });
  });
}

function isMissingColumnError(err, column) {
  return err?.code === "42703" || String(err?.message || "").includes(column);
}

function orderSelectSql(includeTestAndFinal) {
  if (includeTestAndFinal) {
    return `SELECT
         id,
         order_number,
         payment_status,
         order_status,
         promo_code,
         razorpay_order_id,
         razorpay_payment_id,
         payment_method,
         COALESCE(final_total, total_amount) AS expected_total,
         COALESCE(is_test_order, FALSE) AS is_test_order
       FROM orders`;
  }
  return `SELECT
         id,
         order_number,
         payment_status,
         order_status,
         promo_code,
         razorpay_order_id,
         razorpay_payment_id,
         payment_method,
         total_amount AS expected_total,
         FALSE AS is_test_order
       FROM orders`;
}

async function selectOrderForUpdate(client, { razorpayOrderId, orderId }) {
  const run = (sql, params) => client.query(`${sql} FOR UPDATE`, params);
  try {
    if (orderId) {
      return await run(`${orderSelectSql(true)} WHERE id = $1`, [orderId]);
    }
    return await run(`${orderSelectSql(true)} WHERE razorpay_order_id = $1`, [razorpayOrderId]);
  } catch (err) {
    if (isMissingColumnError(err, "is_test_order") || isMissingColumnError(err, "final_total")) {
      if (orderId) {
        return run(`${orderSelectSql(false)} WHERE id = $1`, [orderId]);
      }
      return run(`${orderSelectSql(false)} WHERE razorpay_order_id = $1`, [razorpayOrderId]);
    }
    throw err;
  }
}

async function recordWebhookEvent(client, eventId, eventType) {
  if (!eventId) return { duplicate: false };
  try {
    const inserted = await client.query(
      `INSERT INTO razorpay_webhook_events (event_id, event_type)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId, eventType || "unknown"]
    );
    return { duplicate: inserted.rows.length === 0 };
  } catch (err) {
    if (err?.code === "42P01" || String(err?.message || "").includes("razorpay_webhook_events")) {
      console.warn("razorpay_webhook_events table missing; continuing without event dedup");
      return { duplicate: false };
    }
    throw err;
  }
}

/**
 * If razorpay_order_id is not on the row yet, recover via Razorpay notes.website_order_db_id.
 */
async function recoverOrderFromRazorpayNotes(client, razorpayOrderId) {
  try {
    const rzOrder = await getRazorpayClient().orders.fetch(razorpayOrderId);
    const dbId = Number(rzOrder?.notes?.website_order_db_id);
    if (!Number.isInteger(dbId) || dbId <= 0) return { rows: [] };
    const found = await selectOrderForUpdate(client, { orderId: dbId });
    if (!found.rows.length) return found;
    await client.query(
      `UPDATE orders
       SET razorpay_order_id = COALESCE(razorpay_order_id, $2),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [dbId, razorpayOrderId]
    );
    found.rows[0].razorpay_order_id = found.rows[0].razorpay_order_id || razorpayOrderId;
    return found;
  } catch (err) {
    console.warn("Razorpay notes recovery failed", {
      razorpayOrderId,
      message: err?.error?.description || err?.message,
    });
    return { rows: [] };
  }
}

export function expectedAmountPaise(order) {
  return Math.round(Number(order?.expected_total ?? order?.final_total ?? order?.total_amount) * 100);
}

export function normalizeRazorpayMethod(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!raw || raw === "razorpay") return null;
  const map = {
    upi: "upi",
    card: "card",
    netbanking: "netbanking",
    wallet: "wallet",
    emi: "emi",
    paylater: "paylater",
  };
  return map[raw] || String(value).trim().toLowerCase();
}

export async function fetchCapturedPaymentForOrder(razorpayOrderId) {
  const razorpay = getRazorpayClient();
  const listed = await razorpay.orders.fetchPayments(razorpayOrderId);
  const items = Array.isArray(listed?.items) ? listed.items : [];
  return (
    items.find((p) => String(p.status || "").toLowerCase() === "captured") ||
    null
  );
}

/**
 * Atomically mark the existing order Paid + Confirmed.
 */
export async function confirmCapturedRazorpayPayment({
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature = null,
  paymentMethod = null,
  webhookEventId = null,
  webhookEventType = null,
  capturedAmount = null,
  capturedCurrency = null,
} = {}) {
  const orderIdKey = String(razorpayOrderId || "").trim();
  const paymentId = String(razorpayPaymentId || "").trim();
  if (!orderIdKey || !paymentId) {
    return { status: "ineligible", order: null };
  }

  const client = await pool.connect();
  let newlyPaid = null;
  try {
    await client.query("BEGIN");

    let found = await selectOrderForUpdate(client, { razorpayOrderId: orderIdKey });
    if (!found.rows.length) {
      found = await recoverOrderFromRazorpayNotes(client, orderIdKey);
    }
    if (!found.rows.length) {
      await client.query("ROLLBACK");
      return { status: "not_found", order: null };
    }

    const order = found.rows[0];
    logPaymentEvent("ORDER_FOUND", {
      orderId: order.id,
      orderNumber: order.order_number,
      razorpayOrderId: orderIdKey,
      razorpayPaymentId: paymentId,
      paymentStatus: order.payment_status,
      eventType: webhookEventType || null,
    });

    if (capturedAmount != null) {
      const expectedPaise = expectedAmountPaise(order);
      if (
        Number(capturedAmount) !== expectedPaise ||
        (capturedCurrency && String(capturedCurrency).toUpperCase() !== "INR")
      ) {
        await client.query("ROLLBACK");
        logPaymentEvent("PAYMENT_AMOUNT_MISMATCH", {
          orderId: order.id,
          orderNumber: order.order_number,
          razorpayOrderId: orderIdKey,
          razorpayPaymentId: paymentId,
          expectedPaise,
          paymentAmount: capturedAmount,
          eventType: webhookEventType || null,
        });
        return { status: "amount_mismatch", order };
      }
    }

    if (webhookEventId) {
      const event = await recordWebhookEvent(client, webhookEventId, webhookEventType);
      if (event.duplicate) {
        await client.query("COMMIT");
        logPaymentEvent("ORDER_ALREADY_PAID", {
          orderId: order.id,
          orderNumber: order.order_number,
          razorpayOrderId: orderIdKey,
          razorpayPaymentId: order.razorpay_payment_id || paymentId,
          reason: "duplicate_webhook_event",
          eventType: webhookEventType,
        });
        return { status: "already_paid", order };
      }
    }

    if (order.payment_status === "Paid") {
      await client.query(
        `UPDATE orders
         SET razorpay_payment_id = COALESCE(razorpay_payment_id, $2),
             razorpay_signature = COALESCE(razorpay_signature, $3),
             payment_method = COALESCE(NULLIF($4, ''), payment_method),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND payment_status = 'Paid'`,
        [order.id, paymentId, razorpaySignature, paymentMethod]
      );
      await client.query("COMMIT");
      logPaymentEvent("ORDER_ALREADY_PAID", {
        orderId: order.id,
        orderNumber: order.order_number,
        razorpayOrderId: orderIdKey,
        razorpayPaymentId: order.razorpay_payment_id || paymentId,
        eventType: webhookEventType || null,
      });
      return {
        status: "already_paid",
        order: { ...order, razorpay_payment_id: order.razorpay_payment_id || paymentId },
      };
    }

    if (!["Pending", "Failed"].includes(order.payment_status)) {
      await client.query("ROLLBACK");
      return { status: "ineligible", order };
    }

    let updated;
    try {
      updated = await client.query(
        `UPDATE orders
         SET payment_status = 'Paid',
             order_status = 'Confirmed',
             razorpay_payment_id = $2,
             razorpay_signature = COALESCE($3, razorpay_signature),
             payment_method = COALESCE(NULLIF($4, ''), payment_method),
             payment_date = COALESCE(payment_date, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND payment_status IN ('Pending', 'Failed')
         RETURNING
           id,
           order_number,
           promo_code,
           payment_status,
           order_status,
           payment_method,
           razorpay_order_id,
           razorpay_payment_id,
           COALESCE(is_test_order, FALSE) AS is_test_order`,
        [order.id, paymentId, razorpaySignature, paymentMethod]
      );
    } catch (updErr) {
      if (isMissingColumnError(updErr, "is_test_order")) {
        updated = await client.query(
          `UPDATE orders
           SET payment_status = 'Paid',
               order_status = 'Confirmed',
               razorpay_payment_id = $2,
               razorpay_signature = COALESCE($3, razorpay_signature),
               payment_method = COALESCE(NULLIF($4, ''), payment_method),
               payment_date = COALESCE(payment_date, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
             AND payment_status IN ('Pending', 'Failed')
           RETURNING
             id,
             order_number,
             promo_code,
             payment_status,
             order_status,
             payment_method,
             razorpay_order_id,
             razorpay_payment_id,
             FALSE AS is_test_order`,
          [order.id, paymentId, razorpaySignature, paymentMethod]
        );
      } else {
        throw updErr;
      }
    }

    if (!updated.rows.length) {
      const again = await selectOrderForUpdate(client, { razorpayOrderId: orderIdKey });
      const current = again.rows[0] || order;
      await client.query("COMMIT");
      if (current.payment_status === "Paid") {
        logPaymentEvent("ORDER_ALREADY_PAID", {
          orderId: current.id,
          orderNumber: current.order_number,
          razorpayOrderId: orderIdKey,
          razorpayPaymentId: current.razorpay_payment_id || paymentId,
          reason: "race",
        });
        return { status: "already_paid", order: current };
      }
      return { status: "ineligible", order: current };
    }

    newlyPaid = updated.rows[0];
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logPaymentEvent("DATABASE_UPDATE_FAILED", {
      razorpayOrderId: orderIdKey,
      razorpayPaymentId: paymentId,
      message: err?.message,
      code: err?.code,
    });
    if (err?.code === "23505") {
      const paid = await query(
        `SELECT id, order_number, payment_status, promo_code,
                razorpay_order_id, razorpay_payment_id, payment_method
         FROM orders
         WHERE razorpay_payment_id = $1
         LIMIT 1`,
        [paymentId]
      );
      if (paid.rows[0]?.payment_status === "Paid") {
        logPaymentEvent("ORDER_ALREADY_PAID", {
          orderId: paid.rows[0].id,
          orderNumber: paid.rows[0].order_number,
          razorpayOrderId: orderIdKey,
          razorpayPaymentId: paymentId,
          reason: "unique_payment_id",
        });
        return { status: "already_paid", order: paid.rows[0] };
      }
    }
    throw err;
  } finally {
    client.release();
  }

  if (newlyPaid?.promo_code && !newlyPaid.is_test_order) {
    const incremented = await incrementPromoUsedCount(newlyPaid.promo_code);
    if (!incremented) {
      console.warn(
        "Promo used_count was not incremented (inactive/limit/missing):",
        newlyPaid.promo_code
      );
    }
  }

  logPaymentEvent("ORDER_UPDATED_PAID", {
    orderId: newlyPaid.id,
    orderNumber: newlyPaid.order_number,
    razorpayOrderId: orderIdKey,
    razorpayPaymentId: paymentId,
    eventType: webhookEventType || "verify-payment",
  });
  logPaymentEvent("PAYMENT_VERIFIED", {
    orderId: newlyPaid.id,
    orderNumber: newlyPaid.order_number,
    razorpayOrderId: orderIdKey,
    razorpayPaymentId: paymentId,
  });

  return { status: "marked_paid", order: newlyPaid };
}

export async function markRazorpayPaymentFailed(razorpayOrderId, webhookEventId, webhookEventType) {
  const orderIdKey = String(razorpayOrderId || "").trim();
  if (!orderIdKey) return { status: "not_found", order: null };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let found = await selectOrderForUpdate(client, { razorpayOrderId: orderIdKey });
    if (!found.rows.length) {
      found = await recoverOrderFromRazorpayNotes(client, orderIdKey);
    }
    if (!found.rows.length) {
      await client.query("ROLLBACK");
      return { status: "not_found", order: null };
    }
    const order = found.rows[0];
    if (webhookEventId) {
      await recordWebhookEvent(client, webhookEventId, webhookEventType);
    }
    if (order.payment_status === "Paid") {
      await client.query("COMMIT");
      logPaymentEvent("ORDER_ALREADY_PAID", {
        orderId: order.id,
        orderNumber: order.order_number,
        razorpayOrderId: orderIdKey,
        eventType: webhookEventType,
        reason: "ignore_failed_after_paid",
      });
      return { status: "already_paid", order };
    }
    await client.query(
      `UPDATE orders
       SET payment_status = 'Failed',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND payment_status <> 'Paid'`,
      [order.id]
    );
    await client.query("COMMIT");
    logPaymentEvent("PAYMENT_FAILED_RECORDED", {
      orderId: order.id,
      orderNumber: order.order_number,
      razorpayOrderId: orderIdKey,
      eventType: webhookEventType,
    });
    return { status: "failed", order };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Confirm a Neon order from Razorpay's live captured payment. Never marks Paid unless captured.
 */
export async function reconcileRazorpayOrder({ razorpayOrderId, orderId } = {}) {
  let rzOrderId = String(razorpayOrderId || "").trim();
  let neonOrder = null;

  if (orderId) {
    const { rows } = await query(
      `SELECT id, order_number, payment_status, razorpay_order_id,
              COALESCE(final_total, total_amount) AS expected_total
       FROM orders WHERE id = $1 LIMIT 1`,
      [orderId]
    );
    neonOrder = rows[0] || null;
    rzOrderId = rzOrderId || String(neonOrder?.razorpay_order_id || "").trim();
  } else if (rzOrderId) {
    const { rows } = await query(
      `SELECT id, order_number, payment_status, razorpay_order_id,
              COALESCE(final_total, total_amount) AS expected_total
       FROM orders WHERE razorpay_order_id = $1 LIMIT 1`,
      [rzOrderId]
    );
    neonOrder = rows[0] || null;
  }

  if (!rzOrderId) {
    return { status: "ineligible", message: "razorpay_order_id is required" };
  }

  const captured = await fetchCapturedPaymentForOrder(rzOrderId);
  if (!captured?.id) {
    return {
      status: "not_captured",
      message: "Razorpay has no captured payment for this order",
      order: neonOrder,
    };
  }

  if (neonOrder) {
    const expectedPaise = expectedAmountPaise(neonOrder);
    if (Number(captured.amount) !== expectedPaise || String(captured.currency || "INR").toUpperCase() !== "INR") {
      logPaymentEvent("PAYMENT_AMOUNT_MISMATCH", {
        orderId: neonOrder.id,
        orderNumber: neonOrder.order_number,
        razorpayOrderId: rzOrderId,
        razorpayPaymentId: captured.id,
        expectedPaise,
        paymentAmount: captured.amount,
      });
      return { status: "amount_mismatch", order: neonOrder };
    }
  }

  const result = await confirmCapturedRazorpayPayment({
    razorpayOrderId: rzOrderId,
    razorpayPaymentId: String(captured.id),
    paymentMethod: normalizeRazorpayMethod(captured.method),
    webhookEventType: "reconcile",
    capturedAmount: captured.amount,
    capturedCurrency: captured.currency,
  });

  if (result.status === "marked_paid") {
    triggerOrderFulfillmentAsync(result.order.id);
  } else if (result.status === "already_paid") {
    triggerOrderFulfillmentAsync(result.order.id);
  }

  return result;
}
