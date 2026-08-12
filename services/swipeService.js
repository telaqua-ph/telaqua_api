/**
 * services/swipeService.js
 *
 * Swipe Document V2 integration for invoice creation and retrieval.
 */

const DEFAULT_SWIPE_BASE_URL = "https://app.getswipe.in/api/partner/v2";
const REQUEST_TIMEOUT_MS = 30000;

function getToken() {
  const token = (process.env.SWIPE_API_KEY || "").trim();
  if (!token) {
    throw new Error("SWIPE_API_KEY is not configured");
  }
  return token;
}

export function getSwipeConfigurationStatus() {
  return {
    apiKeyLoaded: Boolean((process.env.SWIPE_API_KEY || "").trim()),
    baseUrl: (process.env.SWIPE_BASE_URL || DEFAULT_SWIPE_BASE_URL)
      .trim()
      .replace(/\/$/, ""),
  };
}

function maskId(id) {
  const value = String(id || "");
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

async function requestSwipe(path, options = {}) {
  const token = getToken();
  const baseUrl = (process.env.SWIPE_BASE_URL || DEFAULT_SWIPE_BASE_URL)
    .trim()
    .replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });

    return response;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutErr = new Error("Swipe API request timed out");
      timeoutErr.code = "SWIPE_TIMEOUT";
      throw timeoutErr;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildSafeSwipeError(status, data) {
  const summary = data?.message || data?.error || data?.error_code ||
    `Swipe API error`;
  const details = data?.errors && Object.keys(data.errors).length
    ? `: ${JSON.stringify(data.errors)}`
    : "";
  return `Swipe ${status}: ${summary}${details}`.slice(0, 1000);
}

function parseJsonMaybe(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

/**
 * @param {object} order
 * @param {object} payload
 */
export async function createSwipeInvoiceForOrder(order, payload) {
  const config = getSwipeConfigurationStatus();
  console.log("[Invoice] Calling Swipe", {
    orderId: order.id,
    orderNumber: order.order_number,
    endpoint: `${config.baseUrl}/doc`,
    method: "POST",
    apiKeyLoaded: config.apiKeyLoaded,
  });

  let response = await requestSwipe("/doc", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  let responseText = await response.text();
  let data = parseJsonMaybe(responseText);

  // Some Swipe accounts reject invoice creation with "Bank details not found"
  // when the optional payments array is supplied before a bank account is set up.
  // The rejected request creates no document. Retry once without only that optional
  // object so the paid website order still receives its invoice; reconciliation is
  // retained in reference/notes and the invoice total is unchanged.
  const bankDetailsMissing =
    !response.ok &&
    response.status === 400 &&
    /bank details not found/i.test(String(data?.message || data?.error || "")) &&
    Array.isArray(payload.payments);
  if (bankDetailsMissing) {
    console.warn("[Invoice] Swipe has no bank details; retrying document without payment record", {
      orderId: order.id,
    });
    const fallbackPayload = { ...payload };
    delete fallbackPayload.payments;
    fallbackPayload.notes = [
      payload.notes,
      `Paid via Razorpay: ${order.razorpay_payment_id}`,
    ].filter(Boolean).join("; ");
    response = await requestSwipe("/doc", {
      method: "POST",
      body: JSON.stringify(fallbackPayload),
    });
    responseText = await response.text();
    data = parseJsonMaybe(responseText);
  }

  console.log("[Invoice] Swipe response received", {
    orderId: order.id,
    httpStatus: response.status,
    ok: response.ok,
    response: response.ok
      ? { success: data?.success, hash_id: data?.data?.hash_id ? "present" : "missing", serial_number: data?.data?.serial_number || null }
      : { message: data?.message, error_code: data?.error_code, errors: data?.errors },
  });

  if (!response.ok || data?.success === false) {
    const err = new Error(buildSafeSwipeError(response.status, data));
    err.statusCode = response.status;
    err.safeSwipeResponse = {
      message: data?.message || null,
      error_code: data?.error_code || null,
      errors: data?.errors || null,
    };
    throw err;
  }

  if (!data?.data?.hash_id) {
    throw new Error("Swipe response missing hash_id");
  }

  return data;
}

/**
 * @param {string} hashId
 */
export async function getSwipeInvoiceDetails(hashId) {
  const response = await requestSwipe(`/doc/${encodeURIComponent(hashId)}`, {
    method: "GET",
  });

  const text = await response.text();
  const data = parseJsonMaybe(text);

  if (!response.ok || data?.success === false) {
    const err = new Error(buildSafeSwipeError(response.status, data));
    err.statusCode = response.status;
    err.swipeResponse = data;
    throw err;
  }

  return data;
}

/**
 * @param {string} hashId
 */
export async function getSwipeInvoicePdf(hashId) {
  const response = await requestSwipe(`/doc/pdf/${encodeURIComponent(hashId)}`, {
    method: "GET",
  });

  if (!response.ok) {
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    const err = new Error(buildSafeSwipeError(response.status, data));
    err.statusCode = response.status;
    err.swipeResponse = data;
    throw err;
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get("content-type") || "application/pdf",
    fileName: `${maskId(hashId)}.pdf`,
  };
}
