/**
 * routes/orders.js
 */

import { Router } from "express";
import {
  listOrders,
  createOrder,
  getOrderById,
  updateOrder,
  deleteOrder,
} from "../controllers/orderController.js";
import {
  downloadOrderInvoice,
  processOrderInvoice,
} from "../controllers/invoiceController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/", requireAuth, listOrders);
router.post("/", createOrder);
router.post("/:orderId/invoice", requireAuth, processOrderInvoice);
router.post("/:orderId/retry-invoice", requireAuth, processOrderInvoice);
router.get("/:orderId/invoice/download", requireAuth, downloadOrderInvoice);
router.get("/:id", getOrderById);
router.put("/:id", requireAuth, updateOrder);
router.delete("/:id", requireAuth, deleteOrder);

export default router;
