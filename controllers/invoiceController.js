/**
 * controllers/invoiceController.js
 *
 * Manual admin retry: generate invoice + send WhatsApp for paid orders.
 */

import { processOrderFulfillment } from "../services/invoiceService.js";

function parseOrderId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

/** POST /api/orders/:orderId/invoice */
export async function processOrderInvoice(req, res) {
  try {
    const orderId = parseOrderId(req.params.orderId);
    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Invalid order id",
      });
    }

    const result = await processOrderFulfillment(orderId);

    return res.status(200).json({
      success: true,
      message: "Invoice processed",
      invoice: {
        invoice_number: result.invoice.invoice_number,
        invoice_url: result.invoice.invoice_url,
        invoice_generated_at: result.invoice.invoice_generated_at,
      },
      whatsapp: {
        status: result.whatsapp.status,
        message_id: result.whatsapp.message_id,
        sent_at: result.whatsapp.sent_at,
        error: result.whatsapp.error,
      },
    });
  } catch (error) {
    console.error("Process order invoice error:", error?.message || error);

    const status = error?.statusCode || 500;
    if (status === 404) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }
    if (status === 400) {
      return res.status(400).json({
        success: false,
        message: error.message || "Order is not eligible for invoice",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to process invoice",
    });
  }
}
