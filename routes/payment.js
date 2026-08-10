/**
 * routes/payment.js
 */

import { Router } from "express";
import {
  createPaymentOrder,
  verifyPayment,
} from "../controllers/paymentController.js";

const router = Router();

router.post("/create-order", createPaymentOrder);
router.post("/verify-payment", verifyPayment);

export default router;
