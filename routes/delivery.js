/**
 * routes/delivery.js
 *
 * Delhivery-related public routes.
 */

import { Router } from "express";
import {
  checkPincode,
  checkTat,
  fetchWaybills,
  calculateRate,
  createWarehouse,
  createShipmentForOrder,
  updateShipmentDetails,
  trackShipmentStatus,
  generateLabel,
  createPickupRequest,
  updateNdrAction,
} from "../controllers/deliveryController.js";

const router = Router();

router.get("/serviceability/:pincode", checkPincode);
router.get("/tat", checkTat);
router.get("/waybill", fetchWaybills);
router.get("/rate", calculateRate);
router.post("/warehouse/create", createWarehouse);
router.post("/shipment/create", createShipmentForOrder);
router.post("/shipment/update", updateShipmentDetails);
router.post("/tracking", trackShipmentStatus);
router.post("/label", generateLabel);
router.post("/pickup", createPickupRequest);
router.post("/ndr", updateNdrAction);

export default router;
