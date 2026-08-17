/**
 * controllers/deliveryController.js
 *
 * Delhivery delivery endpoints:
 * - Pincode serviceability
 * - Expected TAT
 * - Waybill / AWB bulk fetch
 * - Rate calculator
 * - Client warehouse create
 * - Shipment create
 * - Shipment update / edit
 * - Shipment tracking
 * - Packing slip / shipping label
 * - Pickup request
 * - NDR update
 */

import {
  checkPincodeServiceability,
  getExpectedTat,
  getWaybills,
  getShippingRate,
  createClientWarehouse,
  updateClientWarehouse,
  createShipment,
  updateShipment,
  trackShipment,
  generateShippingLabel,
  requestPickup,
  updateNdr,
} from "../services/delhiveryService.js";
import { query } from "../config/db.js";

/** Sensible upper bound for bulk waybill requests. */
const MAX_WAYBILL_COUNT = 100;

/** Max chargeable weight in grams (50 kg). */
const MAX_CGM = 50000;

const ALLOWED_MD = ["E", "S"];
/** Delhivery Invoice Charge API: Delivered, RTO, DTO only. */
const ALLOWED_SS = ["Delivered", "RTO", "DTO"];

/** Exact Client Warehouse Create fields allowed by Delhivery. */
const WAREHOUSE_FIELDS = [
  "name",
  "registered_name",
  "address",
  "city",
  "pin",
  "phone",
  "email",
  "country",
  "return_address",
  "return_pin",
  "return_city",
  "return_state",
  "return_country",
];

/**
 * Delhivery Edit Order API — keys that can be updated (besides required waybill).
 * Docs: name, add, phone, cod, gm, shipment_length/width/height, product_details, pt
 */
const SHIPMENT_UPDATE_OPTIONAL_FIELDS = [
  "name",
  "add",
  "phone",
  "cod",
  "gm",
  "shipment_length",
  "shipment_width",
  "shipment_height",
  "product_details",
  "pt",
];

const ALLOWED_PAYMENT_MODES_PT = ["COD", "Pre-paid", "Prepaid", "Pickup"];

/** Delhivery rejects these characters in CMU payloads unless JSON-escaped carefully. */
const DELHIVERY_FORBIDDEN_CHARS = /[&#%;\\]/g;

/**
 * Map Delhivery service errors to HTTP responses.
 * Never exposes tokens or stack traces.
 */
function handleDelhiveryError(res, error, contextLabel) {
  console.error(`${contextLabel} error:`, {
    code: error?.code,
    status: error?.status,
    message: error?.message,
  });

  if (error?.code === "DELHIVERY_CONFIG_ERROR") {
    return res.status(500).json({
      success: false,
      message: error.message || "Delhivery is not configured",
    });
  }

  if (error?.code === "DELHIVERY_TIMEOUT") {
    return res.status(504).json({
      success: false,
      message: "Delhivery request timed out. Please try again.",
    });
  }

  if (error?.code === "ORDERS_COLUMN_MISSING" || error?.code === "AWB_SAVE_FAILED") {
    return res.status(500).json({
      success: false,
      message: error.message || "Cannot save AWB on the existing orders row",
      ...(error.awb ? { awb: error.awb, waybill: error.awb } : {}),
    });
  }

  if (error?.code === "DELHIVERY_NETWORK_ERROR") {
    return res.status(502).json({
      success: false,
      message: "Delhivery service is currently unavailable",
    });
  }

  if (error?.code === "DELHIVERY_INVALID_RESPONSE") {
    return res.status(502).json({
      success: false,
      message: "Delhivery returned an invalid or unexpected response",
    });
  }

  if (error?.code === "DELHIVERY_UPSTREAM_ERROR") {
    const status = error.status;
    const upstreamMessage =
      typeof error.message === "string" &&
      error.message &&
      !error.message.startsWith("Delhivery API returned HTTP")
        ? error.message
        : null;

    if (status === 401) {
      return res.status(401).json({
        success: false,
        message: upstreamMessage || "Delhivery authentication failed",
      });
    }

    if (status === 403) {
      return res.status(403).json({
        success: false,
        message: "Delhivery permission denied",
      });
    }

    if (status === 404) {
      return res.status(404).json({
        success: false,
        message: "Delhivery route or resource is unavailable",
      });
    }

    if (status === 409) {
      return res.status(409).json({
        success: false,
        message: upstreamMessage || "Conflict with existing Delhivery resource",
        ...(error.upstreamBody ? { data: error.upstreamBody } : {}),
      });
    }

    if (status === 429) {
      return res.status(429).json({
        success: false,
        message: "Delhivery rate limit exceeded. Please try again later.",
      });
    }

    if (status === 422) {
      return res.status(422).json({
        success: false,
        message: upstreamMessage || "Invalid shipment payload for Delhivery",
        ...(error.upstreamBody ? { data: error.upstreamBody } : {}),
      });
    }

    if (status === 400) {
      const msg = (
        upstreamMessage ||
        JSON.stringify(error.upstreamBody || {})
      ).toLowerCase();
      const looksLikeDuplicate =
        msg.includes("already exists") ||
        msg.includes("already exist") ||
        msg.includes("duplicate");

      if (looksLikeDuplicate) {
        return res.status(409).json({
          success: false,
          message: upstreamMessage || "Resource already exists in Delhivery",
          ...(error.upstreamBody ? { data: error.upstreamBody } : {}),
        });
      }

      return res.status(400).json({
        success: false,
        message: upstreamMessage || "Invalid data for Delhivery",
        ...(error.upstreamBody ? { data: error.upstreamBody } : {}),
      });
    }

    if (status >= 500) {
      return res.status(502).json({
        success: false,
        message: upstreamMessage || "Delhivery service is currently unavailable",
      });
    }

    return res.status(502).json({
      success: false,
      message: upstreamMessage || "Unable to complete Delhivery request",
    });
  }

  return res.status(500).json({
    success: false,
    message: "Internal server error",
  });
}

/**
 * Require a non-empty trimmed string field from the request body.
 * @param {object} body
 * @param {string} field
 * @returns {{ ok: true, value: string } | { ok: false, message: string }}
 */
function requireStringField(body, field) {
  const raw = body?.[field];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { ok: false, message: `${field} is required` };
  }
  return { ok: true, value: String(raw).trim() };
}

/**
 * Sanitize free-text for Delhivery CMU (strip characters Delhivery rejects).
 * @param {string} value
 * @returns {string}
 */
function sanitizeDelhiveryText(value) {
  return String(value ?? "")
    .replace(DELHIVERY_FORBIDDEN_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map Telaqua payment_method to Delhivery payment_mode.
 * Docs: COD or Pre-paid for forward shipments.
 * @param {string} paymentMethod
 * @returns {"COD"|"Pre-paid"|null}
 */
function mapPaymentMode(paymentMethod) {
  const method = String(paymentMethod || "").trim().toLowerCase();
  if (!method) return null;

  if (
    method === "cod" ||
    method === "cash on delivery" ||
    method === "cash_on_delivery"
  ) {
    return "COD";
  }

  // Razorpay instruments and other prepaid/online methods
  if (
    method === "razorpay" ||
    method === "prepaid" ||
    method === "pre-paid" ||
    method === "online" ||
    method === "upi" ||
    method === "card" ||
    method === "netbanking" ||
    method === "wallet" ||
    method === "emi" ||
    method === "paylater"
  ) {
    return "Pre-paid";
  }

  return null;
}

/**
 * Read an env string, collapsing Hostinger/multiline whitespace.
 * @param {string} name
 * @returns {string}
 */
function readEnvText(name) {
  return String(process.env[name] || "")
    .replace(/\r\n/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a positive integer env var used for package dimensions (cm).
 * @param {string} name
 * @returns {number|null}
 */
function parsePositiveIntEnv(name) {
  const raw = (process.env[name] || "").trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Read required shipment config from env (warehouse name + product weight + dimensions).
 * @returns {{ ok: true, config: object } | { ok: false, message: string }}
 */
function getShipmentConfig() {
  const warehouseName = readEnvText("TELAQUA_WAREHOUSE_NAME");
  const warehouseAddress = readEnvText("TELAQUA_WAREHOUSE_ADDRESS");
  const warehouseCity = readEnvText("TELAQUA_WAREHOUSE_CITY");
  const warehouseState = readEnvText("TELAQUA_WAREHOUSE_STATE");
  const warehousePincode = readEnvText("TELAQUA_WAREHOUSE_PINCODE");
  const warehousePhone = readEnvText("TELAQUA_WAREHOUSE_PHONE");
  const productName = (
    process.env.TELAQUA_PRODUCT_NAME ||
    "Tel-Aqua Product"
  ).trim();
  const weightRaw = (process.env.TELAQUA_PRODUCT_WEIGHT_GM || "").trim();
  const lengthCm = parsePositiveIntEnv("TELAQUA_PRODUCT_LENGTH_CM");
  const widthCm = parsePositiveIntEnv("TELAQUA_PRODUCT_WIDTH_CM");
  const heightCm = parsePositiveIntEnv("TELAQUA_PRODUCT_HEIGHT_CM");

  if (!warehouseName) {
    return {
      ok: false,
      message:
        "TELAQUA_WAREHOUSE_NAME is not configured. Set it to the exact Delhivery warehouse/pickup location name.",
    };
  }

  if (!warehouseAddress) {
    return {
      ok: false,
      message:
        "TELAQUA_WAREHOUSE_ADDRESS is not configured. Set the full Tel-Aqua pickup/warehouse street address.",
    };
  }

  if (!weightRaw || !/^\d+$/.test(weightRaw) || Number(weightRaw) <= 0) {
    return {
      ok: false,
      message:
        "TELAQUA_PRODUCT_WEIGHT_GM is not configured. Set a positive integer package weight in grams before creating shipments.",
    };
  }

  const weightGm = Number(weightRaw);
  if (weightGm > MAX_CGM) {
    return {
      ok: false,
      message: `TELAQUA_PRODUCT_WEIGHT_GM cannot exceed ${MAX_CGM} grams`,
    };
  }

  if (lengthCm === null || widthCm === null || heightCm === null) {
    return {
      ok: false,
      message:
        "Actual Tel-Aqua package dimensions are not currently configured. Please provide Length × Width × Height.",
    };
  }

  return {
    ok: true,
    config: {
      warehouseName,
      productName: sanitizeDelhiveryText(productName) || "Tel-Aqua Product",
      weightGm,
      lengthCm,
      widthCm,
      heightCm,
      sellerName: (
        process.env.TELAQUA_BUSINESS_NAME ||
        "Tel-Aqua"
      ).trim(),
      warehousePhone,
      warehouseAddress,
      warehouseCity,
      warehouseState,
      warehousePincode,
    },
  };
}

/**
 * Build Delhivery CMU shipment payload from a Telaqua order + config.
 * Waybill omitted so Delhivery auto-assigns (documented for single-piece).
 * @param {object} order
 * @param {object} config
 * @param {"COD"|"Pre-paid"} paymentMode
 */
function orderChargeAmount(order) {
  const n = Number(order.final_total ?? order.total_amount);
  return n;
}

function buildPickupLocation(config) {
  // Official CMU pickup_location: `name` is the registered warehouse lookup key.
  // `add` is the documented street-address field on the same object.
  const pickup_location = {
    name: config.warehouseName,
    add: sanitizeDelhiveryText(config.warehouseAddress),
  };

  if (config.warehouseCity) {
    pickup_location.city = sanitizeDelhiveryText(config.warehouseCity);
  }
  if (config.warehousePincode && /^\d{6}$/.test(config.warehousePincode)) {
    pickup_location.pin = config.warehousePincode;
  }
  if (config.warehousePhone) {
    pickup_location.phone = config.warehousePhone;
  }
  pickup_location.country = "India";

  return pickup_location;
}

function buildShipmentPayload(order, config, paymentMode) {
  const totalAmount = orderChargeAmount(order);
  const quantity = Number(order.quantity);

  const shipment = {
    name: sanitizeDelhiveryText(order.customer_name),
    add: sanitizeDelhiveryText(order.address),
    pin: String(order.pincode).trim(),
    city: sanitizeDelhiveryText(order.city),
    state: sanitizeDelhiveryText(order.state),
    country: "India",
    phone: String(order.phone).trim(),
    order: String(order.order_number).trim(),
    payment_mode: paymentMode,
    products_desc: config.productName,
    quantity: String(quantity),
    total_amount: totalAmount,
    weight: `${config.weightGm}`,
    shipment_length: config.lengthCm,
    shipment_width: config.widthCm,
    shipment_height: config.heightCm,
  };

  if (paymentMode === "COD") {
    shipment.cod_amount = String(totalAmount);
  }

  if (config.sellerName) {
    shipment.seller_name = sanitizeDelhiveryText(config.sellerName);
  }
  if (config.warehouseAddress) {
    shipment.seller_add = sanitizeDelhiveryText(config.warehouseAddress);
  }

  // Optional return-to-warehouse fields when fully configured
  if (
    config.warehouseAddress &&
    config.warehouseCity &&
    config.warehouseState &&
    config.warehousePincode &&
    /^\d{6}$/.test(config.warehousePincode)
  ) {
    shipment.return_add = sanitizeDelhiveryText(config.warehouseAddress);
    shipment.return_city = sanitizeDelhiveryText(config.warehouseCity);
    shipment.return_state = sanitizeDelhiveryText(config.warehouseState);
    shipment.return_pin = config.warehousePincode;
    shipment.return_country = "India";
    if (config.warehousePhone) {
      shipment.return_phone = config.warehousePhone;
    }
  }

  return {
    pickup_location: buildPickupLocation(config),
    shipments: [shipment],
  };
}

let lastSyncedRegisteredWarehouseKey = "";

/**
 * Delhivery One displays the *registered* warehouse address looked up by
 * pickup_location.name. CMU `pickup_location.add` is often ignored in the UI.
 * Sync the documented Client Warehouse Edit `address` field from env.
 * @param {object} config
 */
async function syncRegisteredPickupWarehouse(config) {
  const name = config.warehouseName;
  const address = sanitizeDelhiveryText(config.warehouseAddress);
  const pin = config.warehousePincode;

  if (!name || !address || !/^\d{6}$/.test(pin)) {
    console.warn(
      "Skipping Delhivery warehouse address sync: name, TELAQUA_WAREHOUSE_ADDRESS, or TELAQUA_WAREHOUSE_PINCODE is incomplete"
    );
    return;
  }

  const payload = { name, address, pin };
  const phoneDigits = String(config.warehousePhone || "").replace(/\D/g, "");
  if (phoneDigits.length >= 7 && phoneDigits.length <= 15) {
    payload.phone = phoneDigits;
  }

  const syncKey = `${payload.name}|${payload.address}|${payload.pin}|${payload.phone || ""}`;
  if (lastSyncedRegisteredWarehouseKey === syncKey) {
    console.log("Delhivery registered warehouse address already synced this process");
    return;
  }

  try {
    const data = await updateClientWarehouse(payload);
    const failed =
      data?.success === false ||
      (typeof data?.error === "string" && data.error.trim() !== "");
    console.log("Delhivery registered warehouse address sync:", {
      name: payload.name,
      address: payload.address,
      pin: payload.pin,
      success: !failed,
      message: data?.data?.message || data?.message || data?.error || null,
    });
    if (!failed) {
      lastSyncedRegisteredWarehouseKey = syncKey;
    }
  } catch (error) {
    console.error("Delhivery registered warehouse address sync failed:", {
      code: error?.code,
      status: error?.status,
      message: error?.message,
    });
  }
}

/**
 * True if a value looks like a Delhivery AWB (numeric, 8–20 digits).
 * Rejects batch ids / remarks accidentally stored as waybill.
 * @param {*} value
 * @returns {boolean}
 */
function looksLikeAwb(value) {
  const s = String(value ?? "").trim();
  return /^\d{8,20}$/.test(s);
}

/**
 * Extract AWB from Delhivery create-shipment response shapes:
 * packages[].waybill | waybill | wbn | awb
 * Does not use upload_wbn (batch id).
 * @param {object|null} data
 * @returns {string|null}
 */
function extractAwbFromDelhiveryResponse(data) {
  if (!data || typeof data !== "object") return null;
  const firstPkg = Array.isArray(data.packages) ? data.packages[0] : null;
  const candidates = [
    firstPkg?.waybill,
    firstPkg?.wbn,
    firstPkg?.awb,
    firstPkg?.AWB,
    data.waybill,
    data.wbn,
    data.awb,
    data.AWB,
    data.shipment?.waybill,
    data.shipment?.wbn,
  ];
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    if (looksLikeAwb(s)) return s;
  }
  return null;
}

/**
 * AWB already stored on the existing orders row.
 * @param {object} order
 * @returns {string|null}
 */
function existingOrderAwb(order) {
  const candidates = [order?.waybill, order?.awb, order?.AWB];
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    if (looksLikeAwb(s)) return s;
  }
  return null;
}

/**
 * Safe (no secrets) snapshot of a Delhivery body for logs.
 * @param {*} data
 * @returns {object}
 */
function safeDelhiveryResponseSnapshot(data) {
  if (!data || typeof data !== "object") {
    return { type: typeof data };
  }
  const first = Array.isArray(data.packages) ? data.packages[0] : null;
  return {
    keys: Object.keys(data).slice(0, 20),
    package_count: data.package_count,
    success: data.success,
    rmk: data.rmk,
    message: data.message,
    waybill: data.waybill || null,
    wbn: data.wbn || null,
    upload_wbn: data.upload_wbn || null,
    packages_len: Array.isArray(data.packages) ? data.packages.length : 0,
    first_package_keys: first && typeof first === "object" ? Object.keys(first) : [],
    first_package_status: first?.status || null,
    first_package_waybill: first?.waybill || null,
    first_package_remarks: first?.remarks || first?.remark || null,
  };
}

/**
 * Interpret Delhivery CMU create.json responses (including HTTP 200 soft-failures).
 * Success requires a usable AWB. Never treat HTTP 200 alone as created.
 *
 * @param {any} data
 * @returns {{ ok: true, waybill: string, shipmentId: string|null } | { ok: false, status: number, message: string, waybill: null, shipmentId: string|null }}
 */
function interpretShipmentCreateResult(data) {
  if (!data || typeof data !== "object") {
    return {
      ok: false,
      status: 502,
      message: "Delhivery returned an invalid or unexpected response",
      waybill: null,
      shipmentId: null,
    };
  }

  const packages = Array.isArray(data.packages) ? data.packages : [];
  const first = packages[0] || {};
  const waybill = extractAwbFromDelhiveryResponse(data);
  const shipmentId =
    String(data.upload_wbn || data.shipment_id || "").trim() || null;
  const packageRemarks = packages
    .map((pkg) => pkg?.remarks || pkg?.remark || pkg?.status)
    .filter(Boolean)
    .join("; ");
  const combined = `${data.rmk || ""} ${packageRemarks} ${
    typeof data.error === "string" ? data.error : ""
  }`.toLowerCase();
  const looksDuplicate =
    combined.includes("duplicate") ||
    combined.includes("already exists") ||
    combined.includes("already exist");
  const pkgStatus = String(first.status || "").toLowerCase();
  const failedPkg = packages.find((pkg) => {
    const status = String(pkg?.status || "").toLowerCase();
    const remarks = String(pkg?.remarks || pkg?.remark || "").toLowerCase();
    return (
      status === "fail" ||
      status === "failed" ||
      remarks.includes("fail")
    );
  });
  const successFlag =
    data.success === true ||
    data.success === "true" ||
    pkgStatus === "success" ||
    pkgStatus === "ok";

  if (waybill) {
    return { ok: true, waybill, shipmentId };
  }

  if (data.success === false || data.error === true || failedPkg) {
    const message =
      (failedPkg && (failedPkg.remarks || failedPkg.remark)) ||
      packageRemarks ||
      (typeof data.rmk === "string" && data.rmk) ||
      (typeof data.message === "string" && data.message) ||
      "Unable to create Delhivery shipment";
    return {
      ok: false,
      status: looksDuplicate ? 409 : 400,
      message,
      waybill: null,
      shipmentId,
    };
  }

  if (successFlag) {
    return {
      ok: false,
      status: 502,
      message: "Delhivery shipment succeeded but no AWB was returned.",
      waybill: null,
      shipmentId,
    };
  }

  return {
    ok: false,
    status: 502,
    message:
      packageRemarks ||
      (typeof data.rmk === "string" && data.rmk) ||
      "Delhivery did not return a waybill.",
    waybill: null,
    shipmentId,
  };
}

/**
 * Persist AWB on the SAME existing orders row. Never inserts a new order.
 * Does not change order_status (shipment created ≠ shipped).
 * @param {number} orderId
 * @param {{ awb: string, shipmentId?: string|null }} payload
 * @returns {Promise<object>}
 */
async function persistAwbOnOrder(orderId, { awb, shipmentId }) {
  let updated;
  try {
    updated = await query(
      `UPDATE orders SET
         waybill = $2,
         shipment_status = 'Created',
         delhivery_shipment_id = COALESCE($3, delhivery_shipment_id),
         shipment_created_at = COALESCE(shipment_created_at, CURRENT_TIMESTAMP),
         shipment_error = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, waybill, shipment_status, delhivery_shipment_id, shipment_created_at`,
      [orderId, awb, shipmentId || null]
    );
  } catch (err) {
    if (err?.code === "42703") {
      const missing = new Error(
        `Cannot save AWB: a required orders column is missing (${err.message}).`
      );
      missing.code = "ORDERS_COLUMN_MISSING";
      throw missing;
    }
    throw err;
  }

  try {
    await query(
      `UPDATE orders SET delivery_provider = 'Delhivery' WHERE id = $1`,
      [orderId]
    );
  } catch (err) {
    if (err?.code !== "42703") throw err;
  }

  return updated.rows[0];
}

/**
 * Best-effort shipment_error on the same orders row. Never masks the real API error.
 * @param {number} orderId
 * @param {string} message
 */
async function recordShipmentError(orderId, message) {
  try {
    await query(
      `UPDATE orders SET
         shipment_error = $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [orderId, String(message || "").slice(0, 1000)]
    );
  } catch {
    /* ignore missing column / db error */
  }
}

/**
 * Persist pickup request confirmation on the SAME orders row.
 * Only called after Delhivery returns a pickup_id.
 * @param {number} orderId
 * @param {{ pickupId: string }} payload
 */
async function persistPickupOnOrder(orderId, { pickupId }) {
  try {
    const { rows } = await query(
      `UPDATE orders SET
         pickup_status = 'Requested',
         pickup_requested_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, pickup_status, pickup_requested_at, waybill`,
      [orderId]
    );
    console.log("Pickup saved on orders row:", {
      order_id: orderId,
      pickup_id: pickupId,
      waybill: rows[0]?.waybill || null,
      pickup_status: rows[0]?.pickup_status || null,
    });
    return rows[0] || null;
  } catch (err) {
    if (err?.code === "42703") {
      console.warn(
        "Cannot save pickup_status: orders column missing — pickup was still created at Delhivery",
        { order_id: orderId, pickup_id: pickupId }
      );
      return null;
    }
    throw err;
  }
}

/**
 * Interpret Delhivery Pickup Request Creation API responses.
 * Success requires pickup_id — never treat HTTP 200/201 alone as created.
 * @param {any} data
 */
function interpretPickupCreateResult(data) {
  if (!data || typeof data !== "object") {
    return {
      ok: false,
      status: 502,
      message: "Delhivery returned an invalid or unexpected pickup response",
      pickupId: null,
    };
  }

  const pickupIdRaw = data.pickup_id ?? data.pickupId ?? data.id ?? null;
  const pickupId =
    pickupIdRaw !== null && pickupIdRaw !== undefined && String(pickupIdRaw).trim() !== ""
      ? String(pickupIdRaw).trim()
      : null;

  const errorCandidates = [
    data.error,
    data.pickup_location,
    data.detail,
    data.message,
  ];
  const errorMessage = errorCandidates.find(
    (value) => typeof value === "string" && value.trim()
  );

  if (pickupId) {
    return { ok: true, pickupId, data };
  }

  if (data.success === false || errorMessage) {
    const message = errorMessage || "Delhivery did not accept the pickup request";
    const lower = message.toLowerCase();
    const status = lower.includes("invalid pickup location") ||
      lower.includes("does not exist") ||
      lower.includes("doesn't exist")
      ? 400
      : 400;
    return { ok: false, status, message, pickupId: null };
  }

  return {
    ok: false,
    status: 502,
    message: "Delhivery pickup request succeeded but no pickup_id was returned",
    pickupId: null,
  };
}

function isPickupAlreadyRequested(order) {
  const status = String(order?.pickup_status || order?.pickupStatus || "")
    .trim()
    .toLowerCase();
  return (
    status === "requested" ||
    status === "pickup requested" ||
    (Boolean(order?.pickup_requested_at) && status !== "not requested")
  );
}

/**
 * GET /api/delivery/serviceability/:pincode
 * (also available under /api/delhivery/...)
 */
export async function checkPincode(req, res) {
  try {
    const pincode = String(req.params.pincode ?? "").trim();

    if (!pincode || !/^\d{6}$/.test(pincode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid pincode. Pincode must be exactly 6 digits.",
      });
    }

    const data = await checkPincodeServiceability(pincode);

    return res.status(200).json({
      success: true,
      pincode,
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery serviceability");
  }
}

/**
 * GET /api/delhivery/tat?origin_pin=&destination_pin=&mot=
 * Also available under /api/delivery/tat
 */
export async function checkTat(req, res) {
  try {
    const origin_pin = String(req.query.origin_pin ?? "").trim();
    const destination_pin = String(req.query.destination_pin ?? "").trim();
    // Default to surface mode "S" when omitted (Delhivery common default)
    const motRaw = req.query.mot;
    const mot =
      motRaw === undefined || motRaw === null || String(motRaw).trim() === ""
        ? "S"
        : String(motRaw).trim().toUpperCase();

    if (!origin_pin || !/^\d{6}$/.test(origin_pin)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid origin_pin. origin_pin must be exactly 6 digits.",
      });
    }

    if (!destination_pin || !/^\d{6}$/.test(destination_pin)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid destination_pin. destination_pin must be exactly 6 digits.",
      });
    }

    if (!mot) {
      return res.status(400).json({
        success: false,
        message: "mot is required",
      });
    }

    const data = await getExpectedTat({
      origin_pin,
      destination_pin,
      mot,
    });

    return res.status(200).json({
      success: true,
      origin_pin,
      destination_pin,
      mot,
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery TAT");
  }
}

/**
 * GET /api/delhivery/waybill?count=
 * Also available under /api/delivery/waybill
 *
 * Requests waybill/AWB numbers from Delhivery only.
 * Does NOT write to the orders table.
 */
export async function fetchWaybills(req, res) {
  try {
    const raw = req.query.count;

    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return res.status(400).json({
        success: false,
        message: "count is required",
      });
    }

    const countStr = String(raw).trim();

    // Reject decimals / non-integers / non-numeric
    if (!/^\d+$/.test(countStr)) {
      return res.status(400).json({
        success: false,
        message: "count must be a positive integer",
      });
    }

    const count = Number(countStr);

    if (!Number.isInteger(count) || count <= 0) {
      return res.status(400).json({
        success: false,
        message: "count must be a positive integer greater than 0",
      });
    }

    if (count > MAX_WAYBILL_COUNT) {
      return res.status(400).json({
        success: false,
        message: `count cannot exceed ${MAX_WAYBILL_COUNT}`,
      });
    }

    const data = await getWaybills(count);

    return res.status(200).json({
      success: true,
      count,
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery waybill");
  }
}

/**
 * GET /api/delhivery/rate?md=&cgm=&o_pin=&d_pin=&ss=
 * Also available under /api/delivery/rate
 *
 * Calculates estimated shipping charge via Delhivery.
 * Does NOT write to the orders table.
 */
export async function calculateRate(req, res) {
  try {
    const md = String(req.query.md ?? "").trim().toUpperCase();
    const cgmRaw = String(req.query.cgm ?? "").trim();
    const o_pin = String(req.query.o_pin ?? "").trim();
    const d_pin = String(req.query.d_pin ?? "").trim();
    const ss = String(req.query.ss ?? "").trim();

    if (!md) {
      return res.status(400).json({
        success: false,
        message: "md is required (E for Express, S for Surface)",
      });
    }

    if (!ALLOWED_MD.includes(md)) {
      return res.status(400).json({
        success: false,
        message: `Invalid md. Allowed values: ${ALLOWED_MD.join(", ")}`,
      });
    }

    if (!cgmRaw) {
      return res.status(400).json({
        success: false,
        message: "cgm is required (chargeable weight in grams)",
      });
    }

    // Integer grams only — reject decimals / non-numeric
    if (!/^\d+$/.test(cgmRaw)) {
      return res.status(400).json({
        success: false,
        message: "cgm must be a positive integer (grams)",
      });
    }

    const cgm = Number(cgmRaw);
    if (!Number.isInteger(cgm) || cgm <= 0) {
      return res.status(400).json({
        success: false,
        message: "cgm must be a positive integer greater than 0",
      });
    }

    if (cgm > MAX_CGM) {
      return res.status(400).json({
        success: false,
        message: `cgm cannot exceed ${MAX_CGM} grams`,
      });
    }

    if (!o_pin || !/^\d{6}$/.test(o_pin)) {
      return res.status(400).json({
        success: false,
        message: "Invalid o_pin. o_pin must be exactly 6 digits.",
      });
    }

    if (!d_pin || !/^\d{6}$/.test(d_pin)) {
      return res.status(400).json({
        success: false,
        message: "Invalid d_pin. d_pin must be exactly 6 digits.",
      });
    }

    if (!ss) {
      return res.status(400).json({
        success: false,
        message: "ss is required",
      });
    }

    if (!ALLOWED_SS.includes(ss)) {
      return res.status(400).json({
        success: false,
        message: `Invalid ss. Allowed values: ${ALLOWED_SS.join(", ")}`,
      });
    }

    const data = await getShippingRate({
      md,
      cgm,
      o_pin,
      d_pin,
      ss,
    });

    return res.status(200).json({
      success: true,
      md,
      cgm,
      o_pin,
      d_pin,
      ss,
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery rate");
  }
}

/**
 * POST /api/delhivery/warehouse/create
 * Also available under /api/delivery/warehouse/create
 *
 * Registers a Telaqua pickup / client warehouse with Delhivery.
 * Admin/setup operation — does NOT touch the orders table.
 */
export async function createWarehouse(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const payload = {};

    for (const field of WAREHOUSE_FIELDS) {
      const result = requireStringField(body, field);
      if (!result.ok) {
        return res.status(400).json({
          success: false,
          message: result.message,
        });
      }
      payload[field] = result.value;
    }

    if (!/^\d{6}$/.test(payload.pin)) {
      return res.status(400).json({
        success: false,
        message: "Invalid pin. pin must be exactly 6 digits.",
      });
    }

    if (!/^\d{6}$/.test(payload.return_pin)) {
      return res.status(400).json({
        success: false,
        message: "Invalid return_pin. return_pin must be exactly 6 digits.",
      });
    }

    // Delhivery accepts numeric / masking phone; enforce non-empty digits (7–15)
    const phoneDigits = payload.phone.replace(/\D/g, "");
    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone. Provide a valid contact number.",
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    const data = await createClientWarehouse(payload);

    // Delhivery sometimes returns HTTP 200 with an error/already-exists payload
    const dataMessage = String(
      data?.message || data?.msg || data?.error || ""
    ).toLowerCase();
    const indicatesFailure =
      data?.success === false ||
      data?.error === true ||
      dataMessage.includes("already") ||
      dataMessage.includes("exist") ||
      dataMessage.includes("fail");

    if (indicatesFailure) {
      const message =
        (typeof data?.message === "string" && data.message) ||
        (typeof data?.msg === "string" && data.msg) ||
        "Warehouse could not be created";

      const status =
        dataMessage.includes("already") || dataMessage.includes("exist")
          ? 409
          : 400;

      return res.status(status).json({
        success: false,
        message,
        data,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Warehouse created successfully",
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery warehouse create");
  }
}

/**
 * POST /api/delhivery/shipment/create
 * Also available under /api/delivery/shipment/create
 * Optional alias: POST /api/delhivery/create-shipment
 *
 * Creates a Delhivery shipment for an existing Telaqua order.
 * Loads the SAME orders row from Neon, then saves AWB onto that row.
 * Does not change order_status (Created ≠ Shipped).
 */
export async function createShipmentForOrder(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const rawOrderId = body.order_id ?? body.orderId;
    const hasOrderId =
      rawOrderId !== undefined &&
      rawOrderId !== null &&
      String(rawOrderId).trim() !== "";
    const hasOrderNumber =
      body.order_number !== undefined &&
      body.order_number !== null &&
      String(body.order_number).trim() !== "";

    if (!hasOrderId && !hasOrderNumber) {
      return res.status(400).json({
        success: false,
        message: "order_id or order_number is required",
      });
    }

    let order = null;

    if (hasOrderId) {
      const orderId = Number(rawOrderId);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).json({
          success: false,
          message: "order_id must be a positive integer",
        });
      }

      const { rows } = await query(`SELECT * FROM orders WHERE id = $1`, [
        orderId,
      ]);
      order = rows[0] || null;
    } else {
      const orderNumber = String(body.order_number).trim();
      const { rows } = await query(
        `SELECT * FROM orders WHERE order_number = $1`,
        [orderNumber]
      );
      order = rows[0] || null;
    }

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const alreadyAwb = existingOrderAwb(order);
    if (alreadyAwb) {
      return res.status(200).json({
        success: true,
        message: "Shipment already created",
        awb: alreadyAwb,
        waybill: alreadyAwb,
        order_id: order.id,
        order_number: order.order_number,
        shipment_status: order.shipment_status || "Created",
      });
    }

    const fail = async (status, message) => {
      await recordShipmentError(order.id, message);
      return res.status(status).json({
        success: false,
        message,
        order_id: order.id,
        order_number: order.order_number,
      });
    };

    if (!order.customer_name || !String(order.customer_name).trim()) {
      return fail(400, "Order is missing customer_name");
    }
    if (!order.phone || !String(order.phone).trim()) {
      return fail(400, "Order is missing phone");
    }
    if (!order.address || !String(order.address).trim()) {
      return fail(400, "Order is missing address");
    }
    if (!order.city || !String(order.city).trim()) {
      return fail(400, "Order is missing city");
    }
    if (!order.state || !String(order.state).trim()) {
      return fail(400, "Order is missing state");
    }
    if (!order.pincode || !/^\d{6}$/.test(String(order.pincode).trim())) {
      return fail(400, "Order pincode must be a valid 6-digit Indian pincode");
    }
    if (
      order.quantity === undefined ||
      order.quantity === null ||
      Number(order.quantity) <= 0
    ) {
      return fail(400, "Order quantity must be greater than 0");
    }
    const amount = orderChargeAmount(order);
    if (!Number.isFinite(amount) || amount <= 0) {
      return fail(400, "Order amount must be a valid number greater than 0");
    }
    if (!order.payment_method || !String(order.payment_method).trim()) {
      return fail(400, "Order is missing payment_method");
    }
    if (!order.order_number || !String(order.order_number).trim()) {
      return fail(400, "Order is missing order_number");
    }

    if (String(order.order_status || "").trim() === "Cancelled") {
      return fail(400, "Cannot create shipment for a cancelled order");
    }

    const paymentMode = mapPaymentMode(order.payment_method);
    if (!paymentMode) {
      return fail(
        400,
        `Unsupported payment_method for Delhivery: ${order.payment_method}`
      );
    }

    if (
      paymentMode === "Pre-paid" &&
      String(order.payment_status || "").trim() !== "Paid"
    ) {
      return fail(
        400,
        "Prepaid/Razorpay orders must have payment_status Paid before shipment creation"
      );
    }

    const configResult = getShipmentConfig();
    if (!configResult.ok) {
      return fail(500, configResult.message);
    }

    const payload = buildShipmentPayload(
      order,
      configResult.config,
      paymentMode
    );

    console.log("Delhivery shipment create request:", {
      order_id: order.id,
      order_number: order.order_number,
      pin: payload.shipments?.[0]?.pin,
      city: payload.shipments?.[0]?.city,
      state: payload.shipments?.[0]?.state,
      quantity: payload.shipments?.[0]?.quantity,
      payment_mode: payload.shipments?.[0]?.payment_mode,
      warehouse: payload.pickup_location?.name,
      warehouse_add: payload.pickup_location?.add || null,
      warehouse_city: payload.pickup_location?.city || null,
      warehouse_pin: payload.pickup_location?.pin || null,
      warehouse_phone: payload.pickup_location?.phone || null,
      weight: payload.shipments?.[0]?.weight,
      shipment_length: payload.shipments?.[0]?.shipment_length,
      shipment_width: payload.shipments?.[0]?.shipment_width,
      shipment_height: payload.shipments?.[0]?.shipment_height,
    });

    await syncRegisteredPickupWarehouse(configResult.config);

    const data = await createShipment(payload);
    const interpreted = interpretShipmentCreateResult(data);

    if (!interpreted.ok) {
      console.error("Delhivery shipment create failed:", {
        order_id: order.id,
        message: interpreted.message,
        response: safeDelhiveryResponseSnapshot(data),
      });
      await recordShipmentError(order.id, interpreted.message);
      return res.status(interpreted.status).json({
        success: false,
        message: interpreted.message,
        order_id: order.id,
        order_number: order.order_number,
        data,
      });
    }

    const saved = await persistAwbOnOrder(order.id, {
      awb: interpreted.waybill,
      shipmentId: interpreted.shipmentId,
    }).catch((persistErr) => {
      console.error("Failed to save AWB on orders row:", {
        order_id: order.id,
        awb: interpreted.waybill,
        code: persistErr?.code,
        message: persistErr?.message,
      });
      const wrap = new Error(
        `Delhivery created AWB ${interpreted.waybill} but it could not be saved on the order. Do not click Send to Delhivery again.`
      );
      wrap.code = persistErr?.code || "AWB_SAVE_FAILED";
      wrap.status = 500;
      wrap.awb = interpreted.waybill;
      throw wrap;
    });

    return res.status(200).json({
      success: true,
      message: "Shipment created successfully",
      awb: saved?.waybill || interpreted.waybill,
      waybill: saved?.waybill || interpreted.waybill,
      order_id: order.id,
      order_number: order.order_number,
      shipment_status: saved?.shipment_status || "Created",
      delhivery_shipment_id:
        saved?.delhivery_shipment_id || interpreted.shipmentId,
      shipment_created_at: saved?.shipment_created_at,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery shipment create");
  }
}

/**
 * Build and validate Delhivery Edit Order payload.
 * @param {object} body
 * @returns {{ ok: true, payload: object } | { ok: false, message: string }}
 */
function buildShipmentUpdatePayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Invalid JSON body" };
  }

  const waybill = String(body.waybill ?? "").trim();
  if (!waybill) {
    return { ok: false, message: "waybill is required" };
  }

  // Delhivery AWBs are numeric tracking IDs
  if (!/^\d{8,20}$/.test(waybill)) {
    return {
      ok: false,
      message: "waybill must be an 8–20 digit Delhivery AWB number",
    };
  }

  const unknownKeys = Object.keys(body).filter(
    (key) => key !== "waybill" && !SHIPMENT_UPDATE_OPTIONAL_FIELDS.includes(key)
  );
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      message: `Unsupported field(s): ${unknownKeys.join(", ")}. Allowed: waybill, ${SHIPMENT_UPDATE_OPTIONAL_FIELDS.join(", ")}`,
    };
  }

  const payload = { waybill };
  let updateCount = 0;

  if (body.name !== undefined) {
    const name = sanitizeDelhiveryText(body.name);
    if (!name) {
      return { ok: false, message: "name cannot be empty" };
    }
    payload.name = name;
    updateCount += 1;
  }

  if (body.add !== undefined) {
    const add = sanitizeDelhiveryText(body.add);
    if (!add) {
      return { ok: false, message: "add cannot be empty" };
    }
    payload.add = add;
    updateCount += 1;
  }

  if (body.phone !== undefined) {
    const phone = String(body.phone).trim();
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) {
      return {
        ok: false,
        message: "phone must be a valid contact number",
      };
    }
    payload.phone = phone;
    updateCount += 1;
  }

  if (body.cod !== undefined) {
    const cod = Number(body.cod);
    if (!Number.isFinite(cod) || cod < 0) {
      return { ok: false, message: "cod must be a number >= 0" };
    }
    payload.cod = cod;
    updateCount += 1;
  }

  if (body.gm !== undefined) {
    const gm = Number(body.gm);
    if (!Number.isFinite(gm) || gm <= 0 || gm > MAX_CGM) {
      return {
        ok: false,
        message: `gm must be a positive number up to ${MAX_CGM}`,
      };
    }
    payload.gm = gm;
    updateCount += 1;
  }

  for (const dim of ["shipment_length", "shipment_width", "shipment_height"]) {
    if (body[dim] !== undefined) {
      const value = Number(body[dim]);
      if (!Number.isFinite(value) || value <= 0) {
        return {
          ok: false,
          message: `${dim} must be a positive number`,
        };
      }
      payload[dim] = value;
      updateCount += 1;
    }
  }

  if (body.product_details !== undefined) {
    const product_details = sanitizeDelhiveryText(body.product_details);
    if (!product_details) {
      return { ok: false, message: "product_details cannot be empty" };
    }
    payload.product_details = product_details;
    updateCount += 1;
  }

  if (body.pt !== undefined) {
    const pt = String(body.pt).trim();
    if (!ALLOWED_PAYMENT_MODES_PT.includes(pt)) {
      return {
        ok: false,
        message: `Invalid pt. Allowed values: ${ALLOWED_PAYMENT_MODES_PT.join(", ")}`,
      };
    }
    payload.pt = pt;
    updateCount += 1;
  }

  if (updateCount === 0) {
    return {
      ok: false,
      message: `At least one updatable field is required: ${SHIPMENT_UPDATE_OPTIONAL_FIELDS.join(", ")}`,
    };
  }

  return { ok: true, payload };
}

/**
 * POST /api/delhivery/shipment/update
 * Also available under /api/delivery/shipment/update
 *
 * Updates an existing Delhivery shipment by waybill (Edit Order API).
 * Does NOT modify the orders table.
 */
export async function updateShipmentDetails(req, res) {
  try {
    const built = buildShipmentUpdatePayload(req.body);
    if (!built.ok) {
      return res.status(400).json({
        success: false,
        message: built.message,
      });
    }

    const data = await updateShipment(built.payload);

    // Soft failures sometimes arrive as HTTP 200 with error flags
    const dataMessage = String(
      data?.message || data?.msg || data?.error || data?.rmk || ""
    ).toLowerCase();
    const indicatesFailure =
      data?.success === false ||
      data?.error === true ||
      dataMessage.includes("fail") ||
      dataMessage.includes("invalid") ||
      dataMessage.includes("not found") ||
      dataMessage.includes("cannot");

    if (indicatesFailure) {
      const message =
        (typeof data?.message === "string" && data.message) ||
        (typeof data?.msg === "string" && data.msg) ||
        (typeof data?.rmk === "string" && data.rmk) ||
        "Unable to update Delhivery shipment";

      const status =
        dataMessage.includes("not found") || dataMessage.includes("does not exist")
          ? 404
          : dataMessage.includes("already") || dataMessage.includes("conflict")
            ? 409
            : 400;

      return res.status(status).json({
        success: false,
        message,
        waybill: built.payload.waybill,
        data,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Shipment updated successfully",
      waybill: built.payload.waybill,
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery shipment update");
  }
}

/**
 * POST /api/delhivery/tracking
 * Also available under /api/delivery/tracking
 *
 * Tracks a Delhivery shipment by waybill (staging only).
 * Does NOT read/write the orders table.
 */
export async function trackShipmentStatus(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const unknownKeys = Object.keys(body).filter((key) => key !== "waybill");
    if (unknownKeys.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Unsupported field(s): ${unknownKeys.join(", ")}. Allowed: waybill`,
      });
    }

    if (body.waybill === undefined || body.waybill === null) {
      return res.status(400).json({
        success: false,
        message: "Waybill is required",
      });
    }

    const waybill = String(body.waybill).trim();
    if (!waybill) {
      return res.status(400).json({
        success: false,
        message: "Waybill is required",
      });
    }

    if (!/^\d{8,20}$/.test(waybill)) {
      return res.status(400).json({
        success: false,
        message: "waybill must be an 8–20 digit Delhivery AWB number",
      });
    }

    const data = await trackShipment(waybill);

    return res.status(200).json({
      success: true,
      message: "Shipment tracking fetched successfully",
      waybill,
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery tracking");
  }
}

/**
 * POST /api/delhivery/label
 * Also available under /api/delivery/label
 *
 * Fetches packing-slip / shipping-label JSON for a waybill (staging only).
 * Delhivery Packing Slip API expects query param `wbns`.
 * Does NOT read/write the orders table.
 */
export async function generateLabel(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const allowedKeys = ["waybill", "wbns"];
    const unknownKeys = Object.keys(body).filter(
      (key) => !allowedKeys.includes(key)
    );
    if (unknownKeys.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Unsupported field(s): ${unknownKeys.join(", ")}. Allowed: waybill, wbns`,
      });
    }

    const raw =
      body.waybill !== undefined && body.waybill !== null
        ? body.waybill
        : body.wbns;

    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return res.status(400).json({
        success: false,
        message: "waybill is required (Delhivery packing slip uses wbns)",
      });
    }

    const waybill = String(raw).trim();
    if (!/^\d{8,20}$/.test(waybill)) {
      return res.status(400).json({
        success: false,
        message: "waybill must be an 8–20 digit Delhivery AWB number",
      });
    }

    const data = await generateShippingLabel(waybill);

    return res.status(200).json({
      success: true,
      message: "Shipping label generated successfully",
      waybill,
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery label");
  }
}

/** Delhivery Pickup Request Creation — documented required fields only. */
const PICKUP_REQUIRED_FIELDS = [
  "pickup_time",
  "pickup_date",
  "pickup_location",
  "expected_package_count",
];
const PICKUP_BODY_FIELDS = [...PICKUP_REQUIRED_FIELDS, "order_id"];

/**
 * Build/validate Delhivery pickup request payload.
 * Optional order_id is accepted for linking/logging but is not sent to Delhivery.
 * @param {object} body
 * @returns {{ ok: true, payload: object } | { ok: false, message: string }}
 */
function buildPickupPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Invalid JSON body" };
  }

  const unknownKeys = Object.keys(body).filter(
    (key) => !PICKUP_BODY_FIELDS.includes(key)
  );
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      message: `Unsupported field(s): ${unknownKeys.join(", ")}. Allowed: ${PICKUP_BODY_FIELDS.join(", ")}`,
    };
  }

  const pickup_time = String(body.pickup_time ?? "").trim();
  const pickup_date = String(body.pickup_date ?? "").trim();
  let pickup_location = String(body.pickup_location ?? "").trim();
  const countRaw = body.expected_package_count;

  if (!pickup_location) {
    pickup_location = readEnvText("TELAQUA_WAREHOUSE_NAME");
  }

  if (!pickup_time) {
    return { ok: false, message: "pickup_time is required (HH:MM:SS)" };
  }
  if (!/^\d{2}:\d{2}:\d{2}$/.test(pickup_time)) {
    return {
      ok: false,
      message: "pickup_time must be in HH:MM:SS format",
    };
  }

  if (!pickup_date) {
    return { ok: false, message: "pickup_date is required (YYYY-MM-DD)" };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickup_date)) {
    return {
      ok: false,
      message: "pickup_date must be in YYYY-MM-DD format",
    };
  }

  // Basic calendar validity check
  const dateParts = pickup_date.split("-").map(Number);
  const parsedDate = new Date(
    Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2])
  );
  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.getUTCFullYear() !== dateParts[0] ||
    parsedDate.getUTCMonth() + 1 !== dateParts[1] ||
    parsedDate.getUTCDate() !== dateParts[2]
  ) {
    return { ok: false, message: "pickup_date is not a valid calendar date" };
  }

  if (!pickup_location) {
    return {
      ok: false,
      message:
        "pickup_location is required (exact registered Delhivery warehouse name). Set TELAQUA_WAREHOUSE_NAME or pass pickup_location in the request body.",
    };
  }

  if (countRaw === undefined || countRaw === null || String(countRaw).trim() === "") {
    return { ok: false, message: "expected_package_count is required" };
  }

  const countStr = String(countRaw).trim();
  if (!/^\d+$/.test(countStr)) {
    return {
      ok: false,
      message: "expected_package_count must be a positive integer",
    };
  }

  const expected_package_count = Number(countStr);
  if (!Number.isInteger(expected_package_count) || expected_package_count <= 0) {
    return {
      ok: false,
      message: "expected_package_count must be a positive integer greater than 0",
    };
  }

  if (expected_package_count > 10000) {
    return {
      ok: false,
      message: "expected_package_count is unreasonably large",
    };
  }

  return {
    ok: true,
    payload: {
      pickup_time,
      pickup_date,
      pickup_location,
      expected_package_count,
    },
  };
}

/**
 * POST /api/delhivery/pickup
 * Also available under /api/delivery/pickup
 *
 * Creates a Delhivery pickup request (fm/request/new/).
 * Optional order_id links the request to an existing manifested order (AWB required).
 * pickup_status is updated only after Delhivery returns pickup_id.
 */
export async function createPickupRequest(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const rawOrderId = body.order_id ?? body.orderId;
    const hasOrderId =
      rawOrderId !== undefined &&
      rawOrderId !== null &&
      String(rawOrderId).trim() !== "";

    let order = null;
    if (hasOrderId) {
      const orderId = Number(rawOrderId);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).json({
          success: false,
          message: "order_id must be a positive integer",
        });
      }

      const { rows } = await query(`SELECT * FROM orders WHERE id = $1`, [
        orderId,
      ]);
      order = rows[0] || null;
      if (!order) {
        return res.status(404).json({
          success: false,
          message: "Order not found",
        });
      }

      const awb = existingOrderAwb(order);
      if (!awb) {
        return res.status(400).json({
          success: false,
          message:
            "Cannot request pickup before a Delhivery AWB exists on this order",
          order_id: order.id,
          order_number: order.order_number,
        });
      }

      if (isPickupAlreadyRequested(order)) {
        return res.status(409).json({
          success: false,
          message:
            "Pickup was already requested for this order. Do not submit duplicate pickup requests for the same shipment.",
          order_id: order.id,
          order_number: order.order_number,
          pickup_status: order.pickup_status || "Requested",
          pickup_requested_at: order.pickup_requested_at || null,
        });
      }
    }

    const built = buildPickupPayload(body);
    if (!built.ok) {
      return res.status(400).json({
        success: false,
        message: built.message,
      });
    }

    console.log("Delhivery pickup create request:", {
      order_id: order?.id || null,
      order_number: order?.order_number || null,
      waybill: order ? existingOrderAwb(order) : null,
      pickup_date: built.payload.pickup_date,
      pickup_time: built.payload.pickup_time,
      pickup_location: built.payload.pickup_location,
      expected_package_count: built.payload.expected_package_count,
    });

    const data = await requestPickup(built.payload);
    const interpreted = interpretPickupCreateResult(data);

    if (!interpreted.ok) {
      console.error("Delhivery pickup request failed:", {
        order_id: order?.id || null,
        message: interpreted.message,
        response: data,
      });
      return res.status(interpreted.status).json({
        success: false,
        message: interpreted.message,
        order_id: order?.id || null,
        order_number: order?.order_number || null,
        data,
      });
    }

    let savedOrder = null;
    if (order) {
      savedOrder = await persistPickupOnOrder(order.id, {
        pickupId: interpreted.pickupId,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Pickup request created successfully",
      pickup_id: interpreted.pickupId,
      pickup_status: savedOrder?.pickup_status || (order ? "Requested" : null),
      pickup_requested_at: savedOrder?.pickup_requested_at || null,
      order_id: order?.id || null,
      order_number: order?.order_number || null,
      data: interpreted.data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery pickup");
  }
}

/** Documented NDR actions for Asynchronous NDR Package Action API. */
const NDR_ACTIONS = ["RE-ATTEMPT", "DEFER_DLV", "EDIT_DETAILS"];
const NDR_EDIT_DETAIL_FIELDS = ["name", "phone", "add"];

/**
 * Validate one NDR data item from Delhivery's `data` array.
 * @param {object} item
 * @param {number} index
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function validateNdrItem(item, index) {
  const label = `data[${index}]`;

  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { ok: false, message: `${label} must be an object` };
  }

  const unknownKeys = Object.keys(item).filter(
    (key) => !["waybill", "act", "action_data"].includes(key)
  );
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      message: `${label} unsupported field(s): ${unknownKeys.join(", ")}. Allowed: waybill, act, action_data`,
    };
  }

  const waybill = String(item.waybill ?? "").trim();
  if (!waybill) {
    return { ok: false, message: `${label}.waybill is required` };
  }
  if (!/^\d{8,20}$/.test(waybill)) {
    return {
      ok: false,
      message: `${label}.waybill must be an 8–20 digit Delhivery AWB number`,
    };
  }

  const act = String(item.act ?? "").trim();
  if (!act) {
    return { ok: false, message: `${label}.act is required` };
  }
  if (!NDR_ACTIONS.includes(act)) {
    return {
      ok: false,
      message: `${label}.act must be one of: ${NDR_ACTIONS.join(", ")}`,
    };
  }

  const value = { waybill, act };

  if (act === "RE-ATTEMPT") {
    if (item.action_data !== undefined && item.action_data !== null) {
      const actionData = item.action_data;
      if (
        typeof actionData !== "object" ||
        Array.isArray(actionData) ||
        Object.keys(actionData).length > 0
      ) {
        return {
          ok: false,
          message: `${label}.action_data must be omitted or empty for RE-ATTEMPT`,
        };
      }
    }
    return { ok: true, value };
  }

  if (act === "DEFER_DLV") {
    const actionData = item.action_data;
    if (!actionData || typeof actionData !== "object" || Array.isArray(actionData)) {
      return {
        ok: false,
        message: `${label}.action_data is required for DEFER_DLV`,
      };
    }

    const unknownActionKeys = Object.keys(actionData).filter(
      (key) => key !== "deferred_date"
    );
    if (unknownActionKeys.length > 0) {
      return {
        ok: false,
        message: `${label}.action_data unsupported field(s): ${unknownActionKeys.join(", ")}. Allowed: deferred_date`,
      };
    }

    const deferred_date = String(actionData.deferred_date ?? "").trim();
    if (!deferred_date) {
      return {
        ok: false,
        message: `${label}.action_data.deferred_date is required (YYYY-MM-DD)`,
      };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deferred_date)) {
      return {
        ok: false,
        message: `${label}.action_data.deferred_date must be in YYYY-MM-DD format`,
      };
    }

    value.action_data = { deferred_date };
    return { ok: true, value };
  }

  // EDIT_DETAILS — at least one of name, phone, add
  const actionData = item.action_data;
  if (!actionData || typeof actionData !== "object" || Array.isArray(actionData)) {
    return {
      ok: false,
      message: `${label}.action_data is required for EDIT_DETAILS`,
    };
  }

  const unknownActionKeys = Object.keys(actionData).filter(
    (key) => !NDR_EDIT_DETAIL_FIELDS.includes(key)
  );
  if (unknownActionKeys.length > 0) {
    return {
      ok: false,
      message: `${label}.action_data unsupported field(s): ${unknownActionKeys.join(", ")}. Allowed: ${NDR_EDIT_DETAIL_FIELDS.join(", ")}`,
    };
  }

  const cleaned = {};
  for (const field of NDR_EDIT_DETAIL_FIELDS) {
    if (actionData[field] !== undefined && actionData[field] !== null) {
      const text = sanitizeDelhiveryText(actionData[field]);
      if (!text) {
        return {
          ok: false,
          message: `${label}.action_data.${field} cannot be empty`,
        };
      }
      if (field === "phone") {
        const digits = text.replace(/\D/g, "");
        if (digits.length < 7 || digits.length > 15) {
          return {
            ok: false,
            message: `${label}.action_data.phone must be a valid contact number`,
          };
        }
      }
      cleaned[field] = field === "phone" ? String(actionData[field]).trim() : text;
    }
  }

  if (Object.keys(cleaned).length === 0) {
    return {
      ok: false,
      message: `${label}.action_data must include at least one of: ${NDR_EDIT_DETAIL_FIELDS.join(", ")}`,
    };
  }

  value.action_data = cleaned;
  return { ok: true, value };
}

/**
 * Build Delhivery NDR payload: { data: [...] }
 * @param {object} body
 * @returns {{ ok: true, payload: object } | { ok: false, message: string }}
 */
function buildNdrPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Invalid JSON body" };
  }

  const unknownKeys = Object.keys(body).filter((key) => key !== "data");
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      message: `Unsupported field(s): ${unknownKeys.join(", ")}. Allowed: data`,
    };
  }

  if (!Array.isArray(body.data) || body.data.length === 0) {
    return {
      ok: false,
      message: "data is required and must be a non-empty array of NDR actions",
    };
  }

  if (body.data.length > 50) {
    return {
      ok: false,
      message: "data cannot contain more than 50 NDR actions per request",
    };
  }

  const data = [];
  for (let i = 0; i < body.data.length; i += 1) {
    const result = validateNdrItem(body.data[i], i);
    if (!result.ok) {
      return result;
    }
    data.push(result.value);
  }

  return { ok: true, payload: { data } };
}

/**
 * POST /api/delhivery/ndr
 * Also available under /api/delivery/ndr
 *
 * Submits Delhivery NDR package action(s) (staging only).
 * Does NOT read/write the orders table.
 */
export async function updateNdrAction(req, res) {
  try {
    const built = buildNdrPayload(req.body);
    if (!built.ok) {
      return res.status(400).json({
        success: false,
        message: built.message,
      });
    }

    const data = await updateNdr(built.payload);

    return res.status(200).json({
      success: true,
      message: "NDR update submitted successfully",
      data,
    });
  } catch (error) {
    return handleDelhiveryError(res, error, "Delivery NDR update");
  }
}
