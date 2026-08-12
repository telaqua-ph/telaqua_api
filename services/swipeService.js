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
  return (
    data?.message ||
    data?.error ||
    data?.error_code ||
    (data?.errors && JSON.stringify(data.errors).slice(0, 300)) ||
    `Swipe API error (${status})`
  );
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
  console.log("Swipe create invoice started:", {
    orderId: order.id,
    orderNumber: order.order_number,
    reference: payload.reference,
  });

  const response = await requestSwipe("/doc", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const data = parseJsonMaybe(text);

  console.log("Swipe create invoice response:", {
    orderId: order.id,
    status: response.status,
    ok: response.ok,
  });

  if (!response.ok || data?.success === false) {
    const err = new Error(buildSafeSwipeError(response.status, data));
    err.statusCode = response.status;
    err.swipeResponse = data;
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
