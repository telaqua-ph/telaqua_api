/**
 * routes/dashboard.js
 */

import { Router } from "express";
import { getStats } from "../controllers/dashboardController.js";

const router = Router();

router.get("/stats", getStats);

export default router;
