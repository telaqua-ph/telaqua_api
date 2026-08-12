import crypto from "node:crypto";
import { pool, query } from "../config/db.js";
import {
  customerSessionExpiry,
  generateOtp,
  hashOtp,
  hashRequestIp,
  signCustomerToken,
  verifyOtpHash,
} from "../lib/customerAuth.js";
import { normalizeIndianPhone } from "../utils/phoneUtils.js";
import {
  getInteraktOtpConfigurationStatus,
  sendOtp,
} from "../services/interaktOtpService.js";
import { getInteraktConfigurationStatus } from "../services/interaktService.js";
import { trackShipment } from "../services/delhiveryService.js";

const OTP_EXPIRY_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MIN_REQUEST_SECONDS = 60;
const OTP_PHONE_WINDOW_MINUTES = 15;
const OTP_PHONE_WINDOW_LIMIT = 5;
const OTP_IP_WINDOW_MINUTES = 60;
const OTP_IP_WINDOW_LIMIT = 20;
const TRACKING_CACHE_MS = 5 * 60 * 1000;
const trackingCache = new Map();

const PHONE_MATCH_SQL = `
  REGEXP_REPLACE(phone, '[^0-9]', '', 'g') IN ($1, '91' || $1, '0' || $1)
`;

const SAFE_ORDER_COLUMNS = `
  id, order_number, created_at, updated_at, quantity, unit_price,
  COALESCE(final_total, total_amount) AS total_amount,
  payment_method, payment_status, order_status,
  shipment_status, waybill, delhivery_shipment_id,
  shipment_created_at, shipment_confirmed_at,
  pickup_status, pickup_requested_at, tracking_status, tracking_updated_at,
  invoice_number, invoice_generated_at, invoice_status, swipe_invoice_id,
  customer_name, phone, email, address, city, state, pincode
`;

function isSecureRequest(req) {
  if (process.env.NODE_ENV !== "production") return true;
  const forwarded = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0].trim().toLowerCase();
  return req.secure || forwarded === "https";
}

function validatePhone(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid JSON body" };
  }
  const normalized = normalizeIndianPhone(body.phone);
  if (normalized.error) return { error: "Enter a valid Indian mobile number" };
  return { phone: normalized.phoneNumber };
}

function apiOrigin(req) {
  const configured = String(process.env.BACKEND_BASE_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  const forwarded = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0].trim();
  return `${forwarded || req.protocol || "https"}://${req.get("host")}`;
}

function safeOrder(order, req, detailed = false) {
  const paid = String(order.payment_status || "").toLowerCase() === "paid";
  const invoiceAvailable = paid || Boolean(order.swipe_invoice_id) ||
    String(order.invoice_status || "").toLowerCase() === "generated";
  const result = {
    id: order.id,
    order_number: order.order_number,
    created_at: order.created_at,
    updated_at: order.updated_at,
    quantity: order.quantity,
    unit_price: Number(order.unit_price),
    total_amount: Number(order.total_amount),
    payment_method: order.payment_method,
    payment_status: order.payment_status,
    order_status: order.order_status,
    shipment_status: order.shipment_status,
    tracking_number: order.waybill || null,
    tracking_status: order.tracking_status || null,
    tracking_updated_at: order.tracking_updated_at || null,
    shipment_created_at: order.shipment_created_at || null,
    shipment_confirmed_at: order.shipment_confirmed_at || null,
    invoice_available: invoiceAvailable,
    invoice_number: order.invoice_number || null,
    invoice_status: order.invoice_status || null,
    invoice_generated_at: order.invoice_generated_at || null,
    invoice_url: invoiceAvailable
      ? `${apiOrigin(req)}/api/payment/invoice-download?order_id=${encodeURIComponent(order.id)}`
      : null,
  };
  if (detailed) {
    result.delivery_address = {
      name: order.customer_name,
      address: order.address,
      city: order.city,
      state: order.state,
      pincode: order.pincode,
    };
  }
  return result;
}

async function loadOwnedOrder(orderId, phone) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await query(
    `SELECT ${SAFE_ORDER_COLUMNS} FROM orders
     WHERE id = $2 AND ${PHONE_MATCH_SQL}
     LIMIT 1`,
    [phone, id]
  );
  return rows[0] || null;
}

/** POST /api/customer/auth/request-otp */
export async function requestCustomerOtp(req, res) {
  if (!isSecureRequest(req)) {
    return res.status(400).json({ success: false, message: "HTTPS is required" });
  }
  const validated = validatePhone(req.body);
  if (validated.error) {
    return res.status(400).json({ success: false, message: validated.error });
  }

  const phone = validated.phone;
  const otp = generateOtp();
  const otpHash = hashOtp(phone, otp);
  const ipHash = hashRequestIp(req.ip);
  const client = await pool.connect();
  let otpId;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [phone]);
    const rate = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE phone = $1 AND created_at > NOW() - INTERVAL '${OTP_PHONE_WINDOW_MINUTES} minutes')::int AS phone_count,
         COUNT(*) FILTER (WHERE request_ip_hash = $2 AND created_at > NOW() - INTERVAL '${OTP_IP_WINDOW_MINUTES} minutes')::int AS ip_count,
         EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MAX(created_at) FILTER (WHERE phone = $1))) AS seconds_since_last
       FROM customer_auth_otps`,
      [phone, ipHash]
    );
    const limits = rate.rows[0];
    if (
      limits.seconds_since_last !== null &&
      Number(limits.seconds_since_last) < OTP_MIN_REQUEST_SECONDS
    ) {
      await client.query("ROLLBACK");
      return res.status(429).json({
        success: false,
        message: "Please wait before requesting another OTP",
      });
    }
    if (limits.phone_count >= OTP_PHONE_WINDOW_LIMIT || limits.ip_count >= OTP_IP_WINDOW_LIMIT) {
      await client.query("ROLLBACK");
      return res.status(429).json({
        success: false,
        message: "Too many OTP requests. Please try again later.",
      });
    }

    await client.query(
      `UPDATE customer_auth_otps SET invalidated_at = CURRENT_TIMESTAMP
       WHERE phone = $1 AND verified_at IS NULL AND invalidated_at IS NULL`,
      [phone]
    );
    const inserted = await client.query(
      `INSERT INTO customer_auth_otps
         (phone, otp_hash, expires_at, request_ip_hash)
       VALUES ($1, $2, NOW() + INTERVAL '${OTP_EXPIRY_MINUTES} minutes', $3)
       RETURNING id`,
      [phone, otpHash, ipHash]
    );
    otpId = inserted.rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Customer OTP request database error:", error?.message || error);
    return res.status(500).json({ success: false, message: "Unable to request OTP" });
  } finally {
    client.release();
  }

  try {
    const sent = await sendOtp(phone, otp);
    await query(
      `UPDATE customer_auth_otps SET provider_message_id = $2 WHERE id = $1`,
      [otpId, sent.messageId ? String(sent.messageId) : null]
    );
    return res.status(200).json({ success: true, message: "OTP sent successfully" });
  } catch (error) {
    await query(
      `UPDATE customer_auth_otps SET invalidated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [otpId]
    ).catch(() => {});
    console.error("Customer OTP delivery failed:", {
      message: error?.message || String(error),
      code: error?.code || null,
      status: error?.statusCode || null,
      interakt: error?.safeInteraktError || null,
      // Configuration booleans only; never log the API key or OTP.
      config: {
        ...getInteraktConfigurationStatus(),
        ...getInteraktOtpConfigurationStatus(),
      },
    });
    return res.status(502).json({
      success: false,
      message: "Unable to send WhatsApp OTP. Please try again later.",
    });
  }
}

/** GET /api/customer/auth/interakt-status (admin only via router) */
export async function getCustomerOtpProviderStatus(req, res) {
  return res.status(200).json({
    success: true,
    interakt: {
      ...getInteraktConfigurationStatus(),
      ...getInteraktOtpConfigurationStatus(),
    },
  });
}

/** POST /api/customer/auth/verify-otp */
export async function verifyCustomerOtp(req, res) {
  if (!isSecureRequest(req)) {
    return res.status(400).json({ success: false, message: "HTTPS is required" });
  }
  const validated = validatePhone(req.body);
  const otp = typeof req.body?.otp === "string" ? req.body.otp.trim() : "";
  if (validated.error || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ success: false, message: "Invalid phone or OTP" });
  }

  const phone = validated.phone;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [phone]);
    const found = await client.query(
      `SELECT id, otp_hash, expires_at, attempts,
              expires_at > CURRENT_TIMESTAMP AS is_valid
       FROM customer_auth_otps
       WHERE phone = $1 AND verified_at IS NULL AND invalidated_at IS NULL
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [phone]
    );
    if (!found.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "OTP is invalid or expired" });
    }
    const record = found.rows[0];
    if (!record.is_valid) {
      await client.query(
        "UPDATE customer_auth_otps SET invalidated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [record.id]
      );
      await client.query("COMMIT");
      return res.status(400).json({ success: false, message: "OTP is invalid or expired" });
    }
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await client.query("ROLLBACK");
      return res.status(429).json({ success: false, message: "Too many OTP attempts" });
    }
    if (!verifyOtpHash(phone, otp, record.otp_hash)) {
      const nextAttempts = Number(record.attempts) + 1;
      await client.query(
        `UPDATE customer_auth_otps
         SET attempts = $2::smallint,
             invalidated_at = CASE
               WHEN $2::smallint >= $3::smallint THEN CURRENT_TIMESTAMP
               ELSE invalidated_at END
         WHERE id = $1`,
        [record.id, nextAttempts, OTP_MAX_ATTEMPTS]
      );
      await client.query("COMMIT");
      return res.status(nextAttempts >= OTP_MAX_ATTEMPTS ? 429 : 400).json({
        success: false,
        message: nextAttempts >= OTP_MAX_ATTEMPTS
          ? "Too many OTP attempts. Request a new OTP."
          : "OTP is invalid or expired",
      });
    }

    await client.query(
      `UPDATE customer_auth_otps SET verified_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [record.id]
    );
    await client.query(
      `UPDATE customer_auth_otps SET invalidated_at = CURRENT_TIMESTAMP
       WHERE phone = $1 AND id <> $2 AND verified_at IS NULL AND invalidated_at IS NULL`,
      [phone, record.id]
    );
    const tokenId = crypto.randomUUID();
    const expiresAt = customerSessionExpiry();
    await client.query(
      `INSERT INTO customer_sessions (token_id, phone, expires_at)
       VALUES ($1, $2, $3)`,
      [tokenId, phone, expiresAt]
    );
    await client.query("COMMIT");

    const token = signCustomerToken({ phone, tokenId });
    const profile = await loadProfile(phone);
    return res.status(200).json({
      success: true,
      token,
      expires_at: expiresAt,
      customer: profile,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Customer OTP verification error:", error?.message || error);
    return res.status(500).json({ success: false, message: "Unable to verify OTP" });
  } finally {
    client.release();
  }
}

async function loadProfile(phone) {
  const { rows } = await query(
    `SELECT customer_name, email FROM orders
     WHERE ${PHONE_MATCH_SQL}
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  return {
    phone,
    name: rows[0]?.customer_name || null,
    email: rows[0]?.email || null,
  };
}

export async function logoutCustomer(req, res) {
  await query(
    `UPDATE customer_sessions SET revoked_at = CURRENT_TIMESTAMP
     WHERE token_id = $1 AND phone = $2 AND revoked_at IS NULL`,
    [req.customer.tokenId, req.customer.phone]
  );
  return res.status(200).json({ success: true, message: "Logged out successfully" });
}

export async function getCustomerProfile(req, res) {
  return res.status(200).json({
    success: true,
    customer: await loadProfile(req.customer.phone),
  });
}

export async function listCustomerOrders(req, res) {
  const { rows } = await query(
    `SELECT ${SAFE_ORDER_COLUMNS} FROM orders
     WHERE ${PHONE_MATCH_SQL}
     ORDER BY created_at DESC, id DESC`,
    [req.customer.phone]
  );
  return res.status(200).json({
    success: true,
    orders: rows.map((row) => safeOrder(row, req)),
  });
}

export async function getRecentCustomerOrder(req, res) {
  const { rows } = await query(
    `SELECT ${SAFE_ORDER_COLUMNS} FROM orders
     WHERE ${PHONE_MATCH_SQL}
     ORDER BY
       CASE WHEN payment_status = 'Paid' AND order_status NOT IN ('Delivered', 'Cancelled') THEN 0 ELSE 1 END,
       created_at DESC, id DESC
     LIMIT 1`,
    [req.customer.phone]
  );
  if (!rows.length) {
    return res.status(404).json({ success: false, message: "No orders found" });
  }
  return res.status(200).json({ success: true, order: safeOrder(rows[0], req, true) });
}

export async function getCustomerOrder(req, res) {
  const order = await loadOwnedOrder(req.params.orderId, req.customer.phone);
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }
  return res.status(200).json({ success: true, order: safeOrder(order, req, true) });
}

function safeTracking(data, order) {
  const shipmentData = Array.isArray(data?.ShipmentData) ? data.ShipmentData[0] : null;
  const shipment = shipmentData?.Shipment || data?.Shipment || {};
  const status = shipment?.Status || {};
  const scans = Array.isArray(shipment?.Scans) ? shipment.Scans : [];
  return {
    available: true,
    awb: String(order.waybill),
    status: status.Status || status.StatusType || order.tracking_status || null,
    current_location: status.StatusLocation || null,
    estimated_delivery: shipment.ExpectedDeliveryDate || shipment.EDD || null,
    updated_at: status.StatusDateTime || order.tracking_updated_at || null,
    events: scans.slice(0, 50).map((entry) => {
      const detail = entry?.ScanDetail || entry || {};
      return {
        status: detail.Scan || detail.Instructions || null,
        location: detail.ScannedLocation || null,
        timestamp: detail.ScanDateTime || null,
      };
    }),
  };
}

export async function trackCustomerOrder(req, res) {
  const order = await loadOwnedOrder(req.params.orderId, req.customer.phone);
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }
  if (!order.waybill) {
    return res.status(200).json({
      success: true,
      order_number: order.order_number,
      tracking: {
        available: false,
        awb: null,
        status: order.shipment_status || "Not Created",
        current_location: null,
        estimated_delivery: null,
        updated_at: order.tracking_updated_at || null,
        events: [],
      },
    });
  }

  const cached = trackingCache.get(order.id);
  if (cached && cached.expiresAt > Date.now()) {
    return res.status(200).json({
      success: true,
      order_number: order.order_number,
      tracking: cached.tracking,
      cached: true,
    });
  }
  try {
    const data = await trackShipment(order.waybill);
    const tracking = safeTracking(data, order);
    trackingCache.set(order.id, { tracking, expiresAt: Date.now() + TRACKING_CACHE_MS });
    await query(
      `UPDATE orders SET tracking_status = COALESCE($2, tracking_status),
         tracking_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [order.id, tracking.status]
    );
    return res.status(200).json({
      success: true,
      order_number: order.order_number,
      tracking,
      cached: false,
    });
  } catch (error) {
    console.error("Customer Delhivery tracking error:", {
      orderId: order.id,
      code: error?.code,
      status: error?.status,
      message: error?.message,
    });
    return res.status(502).json({
      success: false,
      message: "Tracking service is currently unavailable",
      order_number: order.order_number,
      tracking: {
        available: true,
        awb: String(order.waybill),
        status: order.tracking_status || order.shipment_status || null,
        current_location: null,
        estimated_delivery: null,
        updated_at: order.tracking_updated_at || null,
        events: [],
      },
    });
  }
}
