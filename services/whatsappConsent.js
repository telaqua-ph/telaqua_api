/**
 * services/whatsappConsent.js
 *
 * Parse WhatsApp updates consent from order/payment create bodies.
 * Consent is stored only when the order row is inserted — never earlier.
 */

import { query } from "../config/db.js";

let whatsappColumnsReady = false;

/**
 * Ensure WhatsApp consent columns exist (idempotent).
 */
export async function ensureWhatsappConsentColumns() {
  if (whatsappColumnsReady) return;
  await query(
    `ALTER TABLE orders
     ADD COLUMN IF NOT EXISTS whatsapp_updates_consent BOOLEAN NOT NULL DEFAULT FALSE`
  );
  await query(
    `ALTER TABLE orders
     ADD COLUMN IF NOT EXISTS whatsapp_consent_at TIMESTAMP NULL`
  );
  whatsappColumnsReady = true;
}

/**
 * Validate and normalize whatsapp_updates_consent from a request body.
 * Missing/null → false (backward compatible with older clients).
 * Non-boolean when provided → error.
 *
 * @param {object} body
 * @returns {{ error: string } | { whatsapp_updates_consent: boolean, whatsapp_consent_at: Date|null }}
 */
export function parseWhatsappConsent(body) {
  if (!body || typeof body !== "object") {
    return {
      whatsapp_updates_consent: false,
      whatsapp_consent_at: null,
    };
  }

  const raw = body.whatsapp_updates_consent;

  if (raw === undefined || raw === null) {
    return {
      whatsapp_updates_consent: false,
      whatsapp_consent_at: null,
    };
  }

  if (typeof raw !== "boolean") {
    return { error: "whatsapp_updates_consent must be a boolean" };
  }

  if (raw === true) {
    return {
      whatsapp_updates_consent: true,
      whatsapp_consent_at: new Date(),
    };
  }

  return {
    whatsapp_updates_consent: false,
    whatsapp_consent_at: null,
  };
}
