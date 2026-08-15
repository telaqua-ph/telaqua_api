/**
 * services/delhiveryService.js
 *
 * Delhivery B2C integrations:
 * - Pincode serviceability
 * - Expected TAT
 * - Waybill / AWB bulk fetch
 * - Rate calculator
 * - Client warehouse create
 * - Shipment / package creation (CMU)
 * - Shipment / package edit (update)
 * - Shipment tracking (staging only for this integration step)
 * - Packing slip / shipping label (staging only for this integration step)
 * - Pickup request (staging only for this integration step)
 * - NDR package action update (staging only for this integration step)
 *
 * Token and URLs come from process.env — never hardcoded or fully logged.
 */

/**
 * Read and sanitize Delhivery API token from env.
 * Trims whitespace/newlines and strips accidental surrounding quotes.
 * @returns {string}
 */
function getDelhiveryApiToken() {
  const raw = process.env.DELHIVERY_API_TOKEN;
  if (raw == null) return "";

  let token = String(raw).trim();
  // Remove accidental surrounding quotes from .env values
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }

  return token;
}

/**
 * Resolve DELHIVERY_ENV (staging | production).
 * @returns {string}
 */
function getDelhiveryEnv() {
  const env = (process.env.DELHIVERY_ENV || "").trim().toLowerCase();
  if (env !== "staging" && env !== "production") {
    const err = new Error(
      'DELHIVERY_ENV must be either "staging" or "production"'
    );
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }
  return env;
}

/**
 * Require a non-empty env URL by name.
 * @param {string} name
 * @returns {string}
 */
function requireEnvUrl(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    const err = new Error(`${name} is not configured`);
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }
  return value;
}

/**
 * Resolve the configured Delhivery pincode URL template from env.
 * @returns {{ env: string, urlTemplate: string }}
 */
function getPincodeUrlTemplate() {
  const env = getDelhiveryEnv();

  if (env === "staging") {
    return {
      env,
      urlTemplate: requireEnvUrl("DELHIVERY_STAGING_PINCODE_URL"),
    };
  }

  return {
    env,
    urlTemplate: requireEnvUrl("DELHIVERY_PRODUCTION_PINCODE_URL"),
  };
}

/**
 * Resolve Expected TAT base URL from env.
 * @returns {{ env: string, baseUrl: string }}
 */
function getTatBaseUrl() {
  const env = getDelhiveryEnv();

  if (env === "staging") {
    return {
      env,
      baseUrl: requireEnvUrl("DELHIVERY_STAGING_TAT_URL"),
    };
  }

  return {
    env,
    baseUrl: requireEnvUrl("DELHIVERY_PRODUCTION_TAT_URL"),
  };
}

/**
 * Resolve Waybill bulk JSON base URL from env.
 * @returns {{ env: string, baseUrl: string }}
 */
function getWaybillBaseUrl() {
  const env = getDelhiveryEnv();

  if (env === "staging") {
    return {
      env,
      baseUrl: requireEnvUrl("DELHIVERY_STAGING_WAYBILL_URL"),
    };
  }

  return {
    env,
    baseUrl: requireEnvUrl("DELHIVERY_PRODUCTION_WAYBILL_URL"),
  };
}

/**
 * Resolve Rate Calculator base URL from env.
 * @returns {{ env: string, baseUrl: string }}
 */
function getRateBaseUrl() {
  const env = getDelhiveryEnv();

  if (env === "staging") {
    return {
      env,
      baseUrl: requireEnvUrl("DELHIVERY_STAGING_RATE_URL"),
    };
  }

  return {
    env,
    baseUrl: requireEnvUrl("DELHIVERY_PRODUCTION_RATE_URL"),
  };
}

/**
 * Resolve Client Warehouse Create URL from env.
 * @returns {{ env: string, baseUrl: string }}
 */
function getWarehouseCreateBaseUrl() {
  const env = getDelhiveryEnv();

  if (env === "staging") {
    return {
      env,
      baseUrl: requireEnvUrl("DELHIVERY_STAGING_WAREHOUSE_CREATE_URL"),
    };
  }

  return {
    env,
    baseUrl: requireEnvUrl("DELHIVERY_PRODUCTION_WAREHOUSE_CREATE_URL"),
  };
}

/**
 * Resolve Shipment / Package Creation (CMU) URL from env.
 * @returns {{ env: string, baseUrl: string }}
 */
function getShipmentCreateBaseUrl() {
  const env = getDelhiveryEnv();

  if (env === "staging") {
    return {
      env,
      baseUrl: requireEnvUrl("DELHIVERY_STAGING_SHIPMENT_CREATE_URL"),
    };
  }

  return {
    env,
    baseUrl: requireEnvUrl("DELHIVERY_PRODUCTION_SHIPMENT_CREATE_URL"),
  };
}

/**
 * Resolve Shipment / Package Edit (update) URL from env.
 * @returns {{ env: string, baseUrl: string }}
 */
function getShipmentUpdateBaseUrl() {
  const env = getDelhiveryEnv();

  if (env === "staging") {
    return {
      env,
      baseUrl: requireEnvUrl("DELHIVERY_STAGING_SHIPMENT_UPDATE_URL"),
    };
  }

  return {
    env,
    baseUrl: requireEnvUrl("DELHIVERY_PRODUCTION_SHIPMENT_UPDATE_URL"),
  };
}

/**
 * Resolve Tracking URL.
 * This integration step uses STAGING ONLY — never production tracking URL.
 * @returns {{ env: string, baseUrl: string }}
 */
function getTrackingBaseUrl() {
  const env = getDelhiveryEnv();

  if (env !== "staging") {
    const err = new Error(
      'Tracking API is staging-only. Set DELHIVERY_ENV=staging to use DELHIVERY_STAGING_TRACKING_URL'
    );
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  return {
    env,
    baseUrl: requireEnvUrl("DELHIVERY_STAGING_TRACKING_URL"),
  };
}

/**
 * Resolve Packing Slip / Label URL.
 * This integration step uses STAGING ONLY — never production label URL.
 * @returns {{ env: string, baseUrl: string }}
 */
function getLabelBaseUrl() {
  const env = getDelhiveryEnv();

  if (env !== "staging") {
    const err = new Error(
      'Label API is staging-only. Set DELHIVERY_ENV=staging to use DELHIVERY_STAGING_LABEL_URL'
    );
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  return {
    env,
    baseUrl: requireEnvUrl("DELHIVERY_STAGING_LABEL_URL"),
  };
}

/**
 * Resolve Pickup Request URL.
 * This integration step uses STAGING ONLY — never production pickup URL.
 * @returns {{ env: string, baseUrl: string }}
 */
function getPickupBaseUrl() {
  const env = getDelhiveryEnv();

  if (env !== "staging") {
    const err = new Error(
      'Pickup API is staging-only. Set DELHIVERY_ENV=staging to use DELHIVERY_STAGING_PICKUP_URL'
    );
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  return {
    env,
    baseUrl: requireEnvUrl("DELHIVERY_STAGING_PICKUP_URL"),
  };
}

/**
 * Resolve NDR Update URL.
 * This integration step uses STAGING ONLY — never production NDR URL.
 * @returns {{ env: string, baseUrl: string }}
 */
function getNdrBaseUrl() {
  const env = getDelhiveryEnv();

  if (env !== "staging") {
    const err = new Error(
      'NDR API is staging-only. Set DELHIVERY_ENV=staging to use DELHIVERY_STAGING_NDR_URL'
    );
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  return {
    env,
    baseUrl: requireEnvUrl("DELHIVERY_STAGING_NDR_URL"),
  };
}

/**
 * Build the final Delhivery URL with filter_codes=<pincode>.
 * @param {string} urlTemplate
 * @param {string} pincode
 * @returns {string}
 */
function buildPincodeServiceabilityUrl(urlTemplate, pincode) {
  const normalized = String(urlTemplate).replaceAll(
    "pin_code",
    String(pincode)
  );

  const url = new URL(normalized);
  url.searchParams.set("filter_codes", String(pincode));
  return url.toString();
}

/**
 * Build Expected TAT URL with required query params.
 * @param {string} baseUrl
 * @param {{ origin_pin: string, destination_pin: string, mot: string }} params
 * @returns {string}
 */
function buildExpectedTatUrl(baseUrl, params) {
  const url = new URL(baseUrl);
  url.searchParams.set("origin_pin", params.origin_pin);
  url.searchParams.set("destination_pin", params.destination_pin);
  url.searchParams.set("mot", params.mot);
  return url.toString();
}

/**
 * Log Delhivery request metadata without exposing the token.
 * @param {string} requestUrl
 * @param {string} token
 * @param {object} debugMeta
 */
function logDelhiveryRequest(requestUrl, token, debugMeta = {}) {
  try {
    const debugUrl = new URL(requestUrl);
    console.log("Delhivery request:", {
      ...debugMeta,
      tokenPresent: Boolean(token),
      host: debugUrl.host,
      path: debugUrl.pathname,
      query: Object.fromEntries(debugUrl.searchParams.entries()),
      authScheme: "Token",
    });
  } catch {
    // ignore debug URL parse failures
  }
}

/**
 * Parse Delhivery JSON body safely (may be empty on some errors).
 * @param {Response} response
 * @returns {Promise<any|null>}
 */
async function parseDelhiveryJson(response) {
  const text = await response.text();
  if (!text || !String(text).trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Extract a safe human-readable message from a Delhivery error body.
 * @param {any} body
 * @returns {string|null}
 */
function extractUpstreamMessage(body) {
  if (!body || typeof body !== "object") return null;

  const candidates = [body.message, body.msg, body.error, body.detail];

  // Nested data.message (common in warehouse create errors)
  if (body.data && typeof body.data === "object") {
    candidates.push(body.data.message, body.data.msg, body.data.error);
  }

  // CMU create.json often returns rmk / packages[].remarks
  if (typeof body.rmk === "string") {
    candidates.push(body.rmk);
  }
  if (Array.isArray(body.packages)) {
    for (const pkg of body.packages) {
      if (pkg && typeof pkg.remarks === "string") candidates.push(pkg.remarks);
      if (pkg && typeof pkg.remark === "string") candidates.push(pkg.remark);
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (Array.isArray(candidate) && candidate.length > 0) {
      const joined = candidate
        .map((item) => (typeof item === "string" ? item : null))
        .filter(Boolean)
        .join("; ");
      if (joined) return joined;
    }
  }

  return null;
}

/**
 * Build a structured upstream error from a non-OK Delhivery response.
 * @param {Response} response
 * @param {object} debugMeta
 * @param {any|null} body
 */
function throwUpstreamError(response, debugMeta, body) {
  console.error("Delhivery upstream error:", {
    status: response.status,
    statusText: response.statusText,
    api: debugMeta.api || "unknown",
  });

  const upstreamMessage = extractUpstreamMessage(body);

  const err = new Error(
    upstreamMessage || `Delhivery API returned HTTP ${response.status}`
  );
  err.code = "DELHIVERY_UPSTREAM_ERROR";
  err.status = response.status;
  err.upstreamBody = body;
  throw err;
}

/**
 * Perform a Delhivery GET with Token auth.
 * @param {string} requestUrl
 * @param {string} token
 * @param {object} debugMeta
 */
async function delhiveryGet(requestUrl, token, debugMeta = {}) {
  logDelhiveryRequest(requestUrl, token, { ...debugMeta, method: "GET" });

  let response;
  try {
    response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        Authorization: `Token ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
  } catch (networkError) {
    const err = new Error("Delhivery service is currently unavailable");
    err.code = "DELHIVERY_NETWORK_ERROR";
    err.cause = networkError;
    throw err;
  }

  const body = await parseDelhiveryJson(response);

  if (!response.ok) {
    throwUpstreamError(response, debugMeta, body);
  }

  if (body === null) {
    const err = new Error(
      "Delhivery returned an invalid or unexpected response"
    );
    err.code = "DELHIVERY_INVALID_RESPONSE";
    throw err;
  }

  return body;
}

/**
 * Perform a Delhivery POST with Token auth and JSON body.
 * @param {string} requestUrl
 * @param {string} token
 * @param {object} payload
 * @param {object} debugMeta
 */
async function delhiveryPost(requestUrl, token, payload, debugMeta = {}) {
  logDelhiveryRequest(requestUrl, token, { ...debugMeta, method: "POST" });

  let response;
  try {
    response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Token ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (networkError) {
    const err = new Error("Delhivery service is currently unavailable");
    err.code = "DELHIVERY_NETWORK_ERROR";
    err.cause = networkError;
    throw err;
  }

  const body = await parseDelhiveryJson(response);

  if (!response.ok) {
    throwUpstreamError(response, debugMeta, body);
  }

  if (body === null) {
    const err = new Error(
      "Delhivery returned an invalid or unexpected response"
    );
    err.code = "DELHIVERY_INVALID_RESPONSE";
    throw err;
  }

  return body;
}

/**
 * Perform a Delhivery POST with application/x-www-form-urlencoded body.
 * Used by CMU create.json which requires format=json&data=<payload>.
 * @param {string} requestUrl
 * @param {string} token
 * @param {Record<string, string>} formFields
 * @param {object} debugMeta
 */
async function delhiveryPostForm(requestUrl, token, formFields, debugMeta = {}) {
  logDelhiveryRequest(requestUrl, token, {
    ...debugMeta,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
  });

  let response;
  try {
    response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Token ${token}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(formFields).toString(),
      signal: AbortSignal.timeout(45000),
    });
  } catch (networkError) {
    if (
      networkError?.name === "TimeoutError" ||
      networkError?.name === "AbortError"
    ) {
      const err = new Error("Delhivery request timed out");
      err.code = "DELHIVERY_TIMEOUT";
      err.cause = networkError;
      throw err;
    }
    const err = new Error("Delhivery service is currently unavailable");
    err.code = "DELHIVERY_NETWORK_ERROR";
    err.cause = networkError;
    throw err;
  }

  const body = await parseDelhiveryJson(response);

  if (!response.ok) {
    throwUpstreamError(response, debugMeta, body);
  }

  if (body === null) {
    const err = new Error(
      "Delhivery returned an invalid or unexpected response"
    );
    err.code = "DELHIVERY_INVALID_RESPONSE";
    throw err;
  }

  return body;
}

/**
 * Check whether a consignee pincode is serviceable by Delhivery.
 * @param {string} pincode
 * @returns {Promise<any>}
 */
export async function checkPincodeServiceability(pincode) {
  const token = getDelhiveryApiToken();

  if (!token) {
    const err = new Error("DELHIVERY_API_TOKEN is not configured");
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  const { env, urlTemplate } = getPincodeUrlTemplate();
  const requestUrl = buildPincodeServiceabilityUrl(urlTemplate, pincode);

  return delhiveryGet(requestUrl, token, {
    api: "pincode_serviceability",
    env,
  });
}

/**
 * Fetch Delhivery expected TAT between origin and destination pincodes.
 * @param {{ origin_pin: string, destination_pin: string, mot: string }} params
 * @returns {Promise<any>}
 */
export async function getExpectedTat(params) {
  const token = getDelhiveryApiToken();

  if (!token) {
    const err = new Error("DELHIVERY_API_TOKEN is not configured");
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  const { env, baseUrl } = getTatBaseUrl();
  const requestUrl = buildExpectedTatUrl(baseUrl, params);

  return delhiveryGet(requestUrl, token, {
    api: "expected_tat",
    env,
  });
}

/**
 * Request one or more Delhivery waybill / AWB numbers.
 * @param {number} count - Positive integer (already validated by controller)
 * @returns {Promise<any>}
 */
export async function getWaybills(count) {
  const token = getDelhiveryApiToken();

  if (!token) {
    const err = new Error("DELHIVERY_API_TOKEN is not configured");
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  const { env, baseUrl } = getWaybillBaseUrl();
  const url = new URL(baseUrl);
  url.searchParams.set("count", String(count));

  return delhiveryGet(url.toString(), token, {
    api: "waybill_bulk",
    env,
  });
}

/**
 * Calculate estimated Delhivery shipping charges.
 * @param {{
 *   md: string,
 *   cgm: number,
 *   o_pin: string,
 *   d_pin: string,
 *   ss: string
 * }} params
 * @returns {Promise<any>}
 */
export async function getShippingRate(params) {
  const token = getDelhiveryApiToken();

  if (!token) {
    const err = new Error("DELHIVERY_API_TOKEN is not configured");
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  const { env, baseUrl } = getRateBaseUrl();
  const url = new URL(baseUrl);
  url.searchParams.set("md", params.md);
  url.searchParams.set("cgm", String(params.cgm));
  url.searchParams.set("o_pin", params.o_pin);
  url.searchParams.set("d_pin", params.d_pin);
  url.searchParams.set("ss", params.ss);

  return delhiveryGet(url.toString(), token, {
    api: "rate_calculator",
    env,
  });
}

/**
 * Create / register a client warehouse (pickup location) with Delhivery.
 * Only documented Delhivery fields should be present in `payload`.
 * @param {object} payload
 * @returns {Promise<any>}
 */
export async function createClientWarehouse(payload) {
  const token = getDelhiveryApiToken();

  if (!token) {
    const err = new Error("DELHIVERY_API_TOKEN is not configured");
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  const { env, baseUrl } = getWarehouseCreateBaseUrl();

  return delhiveryPost(baseUrl, token, payload, {
    api: "client_warehouse_create",
    env,
  });
}

/**
 * Create / manifest a Delhivery shipment (CMU create.json).
 * Body must be sent as format=json&data=<JSON> per Delhivery docs.
 * @param {{ pickup_location: object, shipments: object[] }} payload
 * @returns {Promise<any>}
 */
export async function createShipment(payload) {
  const token = getDelhiveryApiToken();

  if (!token) {
    const err = new Error("DELHIVERY_API_TOKEN is not configured");
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  const { env, baseUrl } = getShipmentCreateBaseUrl();
  console.log(`Delhivery shipment environment: ${env}`);

  return delhiveryPostForm(
    baseUrl,
    token,
    {
      format: "json",
      data: JSON.stringify(payload),
    },
    {
      api: "shipment_create",
      env,
    }
  );
}

/**
 * Update / edit an existing Delhivery shipment by waybill (POST /api/p/edit).
 * Payload must only include documented edit fields.
 * @param {object} payload
 * @returns {Promise<any>}
 */
export async function updateShipment(payload) {
  const token = getDelhiveryApiToken();

  if (!token) {
    const err = new Error("DELHIVERY_API_TOKEN is not configured");
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  const { env, baseUrl } = getShipmentUpdateBaseUrl();
  console.log(`Delhivery shipment update environment: ${env}`);

  return delhiveryPost(baseUrl, token, payload, {
    api: "shipment_update",
    env,
  });
}

/**
 * Track a Delhivery shipment by waybill (Pull Tracking API).
 * Staging only — uses DELHIVERY_STAGING_TRACKING_URL exclusively.
 * @param {string} waybill
 * @returns {Promise<any>}
 */
export async function trackShipment(waybill) {
  const token = getDelhiveryApiToken();

  if (!token) {
    const err = new Error("DELHIVERY_API_TOKEN is not configured");
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  const { env, baseUrl } = getTrackingBaseUrl();
  console.log(`Delhivery tracking environment: ${env}`);

  const url = new URL(baseUrl);
  url.searchParams.set("waybill", String(waybill));

  return delhiveryGet(url.toString(), token, {
    api: "shipment_tracking",
    env,
  });
}

/**
 * Generate packing slip / shipping label data for a waybill.
 * Staging only — uses DELHIVERY_STAGING_LABEL_URL exclusively.
 * Delhivery query param is `wbns` (documented Packing Slip API).
 * @param {string} waybill
 * @returns {Promise<any>}
 */
export async function generateShippingLabel(waybill) {
  const token = getDelhiveryApiToken();

  if (!token) {
    const err = new Error("DELHIVERY_API_TOKEN is not configured");
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  const { env, baseUrl } = getLabelBaseUrl();
  console.log(`Delhivery label environment: ${env}`);

  const url = new URL(baseUrl);
  url.searchParams.set("wbns", String(waybill));

  return delhiveryGet(url.toString(), token, {
    api: "packing_slip_label",
    env,
  });
}

/**
 * Create a Delhivery pickup request for a registered warehouse.
 * Staging only — uses DELHIVERY_STAGING_PICKUP_URL exclusively.
 * @param {{
 *   pickup_time: string,
 *   pickup_date: string,
 *   pickup_location: string,
 *   expected_package_count: number
 * }} payload
 * @returns {Promise<any>}
 */
export async function requestPickup(payload) {
  const token = getDelhiveryApiToken();

  if (!token) {
    const err = new Error("DELHIVERY_API_TOKEN is not configured");
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  const { env, baseUrl } = getPickupBaseUrl();
  console.log(`Delhivery pickup environment: ${env}`);

  return delhiveryPost(baseUrl, token, payload, {
    api: "pickup_request",
    env,
  });
}

/**
 * Submit NDR package action(s) to Delhivery (async API).
 * Staging only — uses DELHIVERY_STAGING_NDR_URL exclusively.
 * Expected payload shape: { data: [ { waybill, act, action_data? } ] }
 * @param {{ data: object[] }} payload
 * @returns {Promise<any>}
 */
export async function updateNdr(payload) {
  const token = getDelhiveryApiToken();

  if (!token) {
    const err = new Error("DELHIVERY_API_TOKEN is not configured");
    err.code = "DELHIVERY_CONFIG_ERROR";
    throw err;
  }

  const { env, baseUrl } = getNdrBaseUrl();
  console.log(`Delhivery NDR environment: ${env}`);

  return delhiveryPost(baseUrl, token, payload, {
    api: "ndr_update",
    env,
  });
}
