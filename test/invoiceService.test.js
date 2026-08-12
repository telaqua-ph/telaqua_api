import test from "node:test";
import assert from "node:assert/strict";
import { buildSwipePayload } from "../services/invoiceService.js";

function order(overrides = {}) {
  return {
    id: 1058,
    order_number: "TAQ-001058",
    customer_name: "Test Customer",
    phone: "9876543210",
    email: "test@example.com",
    address: "1 Test Road",
    city: "Hyderabad",
    state: "Telangana",
    pincode: "500001",
    quantity: 1,
    total_amount: 2124,
    final_total: 2124,
    subtotal: 2000,
    discount_amount: 200,
    taxable_amount: 1800,
    gst_amount: 324,
    gst_rate: 18,
    shipping_amount: 0,
    promo_code: "WELCOME10",
    payment_method: "upi",
    payment_date: new Date("2026-08-12T00:00:00Z"),
    razorpay_payment_id: "pay_test123",
    whatsapp_updates_consent: true,
    is_test_order: false,
    ...overrides,
  };
}

test("discounted taxable value, GST, Razorpay payment and Swipe total match", () => {
  const payload = buildSwipePayload(order());
  assert.equal(payload.items[0].net_amount, 1800);
  assert.equal(payload.items[0].total_amount, 2124);
  assert.equal(payload.items[0].tax_rate, 18);
  assert.equal(payload.payments[0].amount, 2124);
  assert.match(payload.reference, /TAQ-001058/);
  assert.match(payload.reference, /pay_test123/);
});

test("multiple quantities use the stored order snapshot", () => {
  const payload = buildSwipePayload(order({
    quantity: 3,
    taxable_amount: 5400,
    gst_amount: 972,
    final_total: 6372,
    total_amount: 6372,
  }));
  assert.equal(payload.items[0].quantity, 3);
  assert.equal(payload.items[0].unit_price, 1800);
  assert.equal(payload.items[0].price_with_tax, 2124);
  assert.equal(payload.payments[0].amount, 6372);
});

test("shipping is included once and preserves the final total", () => {
  const payload = buildSwipePayload(order({
    shipping_amount: 100,
    final_total: 2224,
    total_amount: 2224,
  }));
  assert.equal(payload.items.length, 2);
  assert.equal(payload.items[1].name, "Shipping");
  assert.equal(payload.items[1].total_amount, 100);
  assert.equal(payload.items.reduce((sum, item) => sum + item.total_amount, 0), 2224);
  assert.equal(payload.payments[0].amount, 2224);
});

test("an inconsistent snapshot is rejected before calling Swipe", () => {
  assert.throws(
    () => buildSwipePayload(order({ final_total: 9999 })),
    /financial snapshot is inconsistent/
  );
});
