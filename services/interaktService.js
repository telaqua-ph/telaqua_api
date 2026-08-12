/**
 * services/interaktService.js
 *
 * Send order invoice via Interakt WhatsApp template API.
 * INTERAKT_API_KEY must remain server-side only.
 */

const INTERAKT_API_URL = "https://api.interakt.ai/v1/public/message/";
const TEMPLATE_NAME = "telaqua_order_invoice";
const TEMPLATE_LANGUAGE = "en";
const REQUEST_TIMEOUT_MS = 30000;

function maskPhone(phone) {
  const s = String(phone || "");
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

/**
 * @param {object} params
 * @param {string} params.countryCode - e.g. "+91"
 * @param {string} params.phoneNumber - 10-digit local number
 * @param {string} params.customerName
 * @param {string} params.orderId - order number or id label
 * @param {string|number} params.amount - amount paid (template body)
 * @param {string} params.pdfUrl - public HTTPS invoice URL
 * @param {string} params.fileName - e.g. INV-2026-000123.pdf
 */
export async function sendOrderInvoiceWhatsApp({
  countryCode,
  phoneNumber,
  customerName,
  orderId,
  amount,
  pdfUrl,
  fileName,
}) {
  const apiKey = (process.env.INTERAKT_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("INTERAKT_API_KEY is not configured");
  }

  const amountStr = String(
    typeof amount === "number" && Number.isFinite(amount)
      ? Math.round(amount)
      : amount ?? ""
  );

  const payload = {
    countryCode,
    phoneNumber,
    type: "Template",
    template: {
      name: TEMPLATE_NAME,
      languageCode: TEMPLATE_LANGUAGE,
      headerValues: [pdfUrl],
      fileName,
      bodyValues: [
        String(customerName || "Customer"),
        String(orderId || ""),
        amountStr,
      ],
    },
  };

  console.log("Interakt request started:", {
    template: TEMPLATE_NAME,
    phone: maskPhone(phoneNumber),
    orderId,
    fileName,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(INTERAKT_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    console.log("Interakt response received:", {
      status: response.status,
      ok: response.ok,
    });

    if (!response.ok) {
      const safeMessage =
        data?.message ||
        data?.error ||
        data?.detail ||
        `Interakt API error (${response.status})`;
      const err = new Error(safeMessage);
      err.statusCode = response.status;
      err.interaktResponse = data;
      throw err;
    }

    const messageId =
      data?.id ||
      data?.messageId ||
      data?.message_id ||
      data?.data?.id ||
      data?.data?.messageId ||
      null;

    console.log("WhatsApp sent successfully:", {
      phone: maskPhone(phoneNumber),
      messageId: messageId ? String(messageId).slice(0, 12) + "…" : null,
    });

    return {
      success: true,
      messageId,
      response: data,
    };
  } catch (error) {
    if (error.name === "AbortError") {
      const err = new Error("Interakt API request timed out");
      err.code = "INTERAKT_TIMEOUT";
      throw err;
    }
    console.error("WhatsApp failed:", error?.message || error);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
