/**
 * api/payment/test.js
 *
 * /api/payment/test
 *
 * Simple health-check endpoint to verify Vercel routing works
 * for the payment module (no Razorpay, no database).
 */

/** Apply CORS headers for browser clients. */
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
}

/** Send a JSON response with the given status code. */
function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, {
      success: false,
      message: "Method not allowed",
    });
  }

  return json(res, 200, {
    success: true,
    message: "Payment API is working",
    method: req.method,
    timestamp: new Date().toISOString(),
  });
}
