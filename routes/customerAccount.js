import { Router } from "express";
import {
  getCustomerOrder,
  getCustomerProfile,
  getRecentCustomerOrder,
  listCustomerOrders,
  logoutCustomer,
  requestCustomerOtp,
  trackCustomerOrder,
  verifyCustomerOtp,
} from "../controllers/customerAccountController.js";
import { requireCustomerAuth } from "../middleware/customerAuth.js";

const router = Router();
const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

router.post("/auth/request-otp", asyncRoute(requestCustomerOtp));
router.post("/auth/verify-otp", asyncRoute(verifyCustomerOtp));
router.post("/auth/logout", asyncRoute(requireCustomerAuth), asyncRoute(logoutCustomer));
router.get("/profile", asyncRoute(requireCustomerAuth), asyncRoute(getCustomerProfile));
router.get("/orders", asyncRoute(requireCustomerAuth), asyncRoute(listCustomerOrders));
router.get("/orders/recent", asyncRoute(requireCustomerAuth), asyncRoute(getRecentCustomerOrder));
router.get("/orders/:orderId/tracking", asyncRoute(requireCustomerAuth), asyncRoute(trackCustomerOrder));
router.get("/orders/:orderId", asyncRoute(requireCustomerAuth), asyncRoute(getCustomerOrder));

export default router;
