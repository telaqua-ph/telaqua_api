/**
 * routes/delivery.js
 *
 * Delhivery shipment creation only.
 */

import { Router } from "express";
import { createShipmentForOrder } from "../controllers/deliveryController.js";

const router = Router();

router.post("/shipment/create", createShipmentForOrder);
router.post("/create-shipment", createShipmentForOrder);

export default router;
