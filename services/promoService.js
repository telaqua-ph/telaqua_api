/**
 * services/promoService.js
 *
 * Promo-code lookups against promo_codes.
 * Pricing always comes from the database — never from the client.
 */

import { query } from "../config/db.js";

/**
 * Normalize a promo code for lookups.
 * @param {unknown} code
 * @returns {string}
 */
export function normalizePromoCode(code) {
  return String(code ?? "")
    .trim()
    .toUpperCase();
}

/**
 * Convert DB numeric fields to plain numbers.
 * @param {unknown} value
 * @returns {number}
 */
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Map a promo_codes row to a pricing summary.
 * @param {object} row
 */
export function mapPromoPricing(row) {
  const original_price = toNumber(row.original_price);
  const promo_price = toNumber(row.promo_price);
  const discount_amount = original_price - promo_price;

  return {
    code: String(row.code).trim().toUpperCase(),
    platform: row.platform,
    language: row.language,
    original_price,
    promo_price,
    discount_amount,
  };
}

/**
 * Whether a promo row is still usable under its usage_limit.
 * @param {object} row
 * @returns {boolean}
 */
export function isPromoWithinUsageLimit(row) {
  if (row.usage_limit === null || row.usage_limit === undefined) {
    return true;
  }
  const limit = Number(row.usage_limit);
  const used = Number(row.used_count ?? 0);
  if (!Number.isFinite(limit) || !Number.isFinite(used)) return false;
  return used < limit;
}

/**
 * Find an active, in-limit promo by platform + language.
 * Does not mutate used_count.
 * @param {string} platform
 * @param {string} language
 * @returns {Promise<object|null>}
 */
export async function findOfferByPlatformLanguage(platform, language) {
  const { rows } = await query(
    `SELECT
       id,
       platform,
       language,
       code,
       original_price,
       promo_price,
       is_active,
       usage_limit,
       used_count
     FROM promo_codes
     WHERE LOWER(TRIM(platform)) = LOWER(TRIM($1))
       AND LOWER(TRIM(language)) = LOWER(TRIM($2))
       AND is_active = true
       AND (usage_limit IS NULL OR used_count < usage_limit)
     ORDER BY id ASC
     LIMIT 1`,
    [platform, language]
  );

  return rows[0] || null;
}

/**
 * Find an active, in-limit promo by code.
 * Does not mutate used_count.
 * @param {string} code - Already normalized uppercase
 * @returns {Promise<object|null>}
 */
export async function findActivePromoByCode(code) {
  const { rows } = await query(
    `SELECT
       id,
       platform,
       language,
       code,
       original_price,
       promo_price,
       is_active,
       usage_limit,
       used_count
     FROM promo_codes
     WHERE UPPER(TRIM(code)) = $1
     LIMIT 1`,
    [code]
  );

  const row = rows[0];
  if (!row) return null;
  if (!row.is_active) return null;
  if (!isPromoWithinUsageLimit(row)) return null;
  return row;
}

/**
 * Atomically increment used_count after successful payment.
 * Respects usage_limit when set.
 * @param {string} code
 * @returns {Promise<boolean>} true if a row was updated
 */
export async function incrementPromoUsedCount(code) {
  const normalized = normalizePromoCode(code);
  if (!normalized) return false;

  const { rowCount } = await query(
    `UPDATE promo_codes
     SET used_count = used_count + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE UPPER(TRIM(code)) = $1
       AND is_active = true
       AND (usage_limit IS NULL OR used_count < usage_limit)`,
    [normalized]
  );

  return rowCount > 0;
}
