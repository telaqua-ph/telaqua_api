/**
 * services/promoService.js
 *
 * Promo-code lookups + admin CRUD against promo_codes.
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
 * Map a promo_codes row for API responses.
 * @param {object} row
 */
export function mapPromoRecord(row) {
  return {
    id: row.id,
    platform: row.platform,
    language: row.language,
    code: String(row.code).trim().toUpperCase(),
    original_price: toNumber(row.original_price),
    promo_price: toNumber(row.promo_price),
    is_active: Boolean(row.is_active),
    usage_limit:
      row.usage_limit === null || row.usage_limit === undefined
        ? null
        : Number(row.usage_limit),
    used_count: Number(row.used_count ?? 0),
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
  };
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
 * Find a promo by code (any status). Does not mutate used_count.
 * @param {string} code - Already normalized uppercase
 * @returns {Promise<object|null>}
 */
export async function findPromoByCode(code) {
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
       used_count,
       created_at,
       updated_at
     FROM promo_codes
     WHERE UPPER(TRIM(code)) = $1
     LIMIT 1`,
    [code]
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
  const row = await findPromoByCode(code);
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

/**
 * @param {string|undefined} status - "active" | "inactive" | undefined
 */
export async function listPromoCodes(status) {
  let sql = `
    SELECT
      id,
      platform,
      language,
      code,
      original_price,
      promo_price,
      is_active,
      usage_limit,
      used_count,
      created_at,
      updated_at
    FROM promo_codes
  `;
  const params = [];

  if (status === "active") {
    sql += ` WHERE is_active = true`;
  } else if (status === "inactive") {
    sql += ` WHERE is_active = false`;
  }

  sql += ` ORDER BY id DESC`;

  const { rows } = await query(sql, params);
  return rows;
}

/**
 * @param {number} id
 */
export async function findPromoById(id) {
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
       used_count,
       created_at,
       updated_at
     FROM promo_codes
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * @param {object} data
 */
export async function createPromoCode(data) {
  const { rows } = await query(
    `INSERT INTO promo_codes (
       platform,
       language,
       code,
       original_price,
       promo_price,
       is_active,
       usage_limit,
       used_count,
       created_at,
       updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     )
     RETURNING
       id,
       platform,
       language,
       code,
       original_price,
       promo_price,
       is_active,
       usage_limit,
       used_count,
       created_at,
       updated_at`,
    [
      data.platform,
      data.language,
      data.code,
      data.original_price,
      data.promo_price,
      data.is_active,
      data.usage_limit,
    ]
  );
  return rows[0];
}

/**
 * @param {number} id
 * @param {object} data
 */
export async function updatePromoCode(id, data) {
  const { rows } = await query(
    `UPDATE promo_codes
     SET
       platform = $1,
       language = $2,
       code = $3,
       original_price = $4,
       promo_price = $5,
       usage_limit = $6,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $7
     RETURNING
       id,
       platform,
       language,
       code,
       original_price,
       promo_price,
       is_active,
       usage_limit,
       used_count,
       created_at,
       updated_at`,
    [
      data.platform,
      data.language,
      data.code,
      data.original_price,
      data.promo_price,
      data.usage_limit,
      id,
    ]
  );
  return rows[0] || null;
}

/**
 * @param {number} id
 * @param {boolean} isActive
 */
export async function updatePromoCodeStatus(id, isActive) {
  const { rows } = await query(
    `UPDATE promo_codes
     SET
       is_active = $1,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
     RETURNING
       id,
       platform,
       language,
       code,
       original_price,
       promo_price,
       is_active,
       usage_limit,
       used_count,
       created_at,
       updated_at`,
    [isActive, id]
  );
  return rows[0] || null;
}

/**
 * Check if another promo already uses this code.
 * @param {string} code - normalized
 * @param {number|null} excludeId
 */
export async function promoCodeExists(code, excludeId = null) {
  if (excludeId == null) {
    const { rows } = await query(
      `SELECT id FROM promo_codes WHERE UPPER(TRIM(code)) = $1 LIMIT 1`,
      [code]
    );
    return rows.length > 0;
  }

  const { rows } = await query(
    `SELECT id FROM promo_codes
     WHERE UPPER(TRIM(code)) = $1
       AND id <> $2
     LIMIT 1`,
    [code, excludeId]
  );
  return rows.length > 0;
}
