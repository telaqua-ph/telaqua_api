/**
 * Dashboard sales overview metrics.
 * Admin-only aggregated stats sourced from backend-confirmed paid orders.
 */

import { query } from "../config/db.js";

function emptyStats() {
  return {
    devicesSold: 0,
    revenueReceived: 0,
    todayDevicesSold: 0,
    todayRevenue: 0,
    monthDevicesSold: 0,
    monthRevenue: 0,
  };
}

export async function getStats(req, res) {
  try {
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(quantity), 0)::int AS devices_sold,
         COALESCE(SUM(COALESCE(final_total, total_amount)), 0)::numeric(12,2) AS revenue_received,
         COALESCE(
           SUM(quantity) FILTER (
             WHERE payment_date IS NOT NULL
               AND payment_date >= date_trunc('day', CURRENT_TIMESTAMP)
               AND payment_date < date_trunc('day', CURRENT_TIMESTAMP) + INTERVAL '1 day'
           ),
           0
         )::int AS today_devices_sold,
         COALESCE(
           SUM(COALESCE(final_total, total_amount)) FILTER (
             WHERE payment_date IS NOT NULL
               AND payment_date >= date_trunc('day', CURRENT_TIMESTAMP)
               AND payment_date < date_trunc('day', CURRENT_TIMESTAMP) + INTERVAL '1 day'
           ),
           0
         )::numeric(12,2) AS today_revenue,
         COALESCE(
           SUM(quantity) FILTER (
             WHERE payment_date IS NOT NULL
               AND payment_date >= date_trunc('month', CURRENT_TIMESTAMP)
               AND payment_date < date_trunc('month', CURRENT_TIMESTAMP) + INTERVAL '1 month'
           ),
           0
         )::int AS month_devices_sold,
         COALESCE(
           SUM(COALESCE(final_total, total_amount)) FILTER (
             WHERE payment_date IS NOT NULL
               AND payment_date >= date_trunc('month', CURRENT_TIMESTAMP)
               AND payment_date < date_trunc('month', CURRENT_TIMESTAMP) + INTERVAL '1 month'
           ),
           0
         )::numeric(12,2) AS month_revenue
       FROM orders
       WHERE payment_status = 'Paid'
         AND COALESCE(order_status, '') <> 'Cancelled'
         AND COALESCE(is_test_order, FALSE) = FALSE`
    );

    const stats = rows[0];
    if (!stats) {
      return res.status(200).json({ success: true, ...emptyStats() });
    }

    return res.status(200).json({
      success: true,
      devicesSold: Number(stats.devices_sold || 0),
      revenueReceived: Number(stats.revenue_received || 0),
      todayDevicesSold: Number(stats.today_devices_sold || 0),
      todayRevenue: Number(stats.today_revenue || 0),
      monthDevicesSold: Number(stats.month_devices_sold || 0),
      monthRevenue: Number(stats.month_revenue || 0),
    });
  } catch (error) {
    console.error("Dashboard stats error:", {
      message: error?.message,
      code: error?.code,
    });

    if (
      error?.code === "42703" &&
      String(error?.message || "").includes("is_test_order")
    ) {
      try {
        const { rows } = await query(
          `SELECT
             COALESCE(SUM(quantity), 0)::int AS devices_sold,
             COALESCE(SUM(COALESCE(final_total, total_amount)), 0)::numeric(12,2) AS revenue_received,
             COALESCE(
               SUM(quantity) FILTER (
                 WHERE payment_date IS NOT NULL
                   AND payment_date >= date_trunc('day', CURRENT_TIMESTAMP)
                   AND payment_date < date_trunc('day', CURRENT_TIMESTAMP) + INTERVAL '1 day'
               ),
               0
             )::int AS today_devices_sold,
             COALESCE(
               SUM(COALESCE(final_total, total_amount)) FILTER (
                 WHERE payment_date IS NOT NULL
                   AND payment_date >= date_trunc('day', CURRENT_TIMESTAMP)
                   AND payment_date < date_trunc('day', CURRENT_TIMESTAMP) + INTERVAL '1 day'
               ),
               0
             )::numeric(12,2) AS today_revenue,
             COALESCE(
               SUM(quantity) FILTER (
                 WHERE payment_date IS NOT NULL
                   AND payment_date >= date_trunc('month', CURRENT_TIMESTAMP)
                   AND payment_date < date_trunc('month', CURRENT_TIMESTAMP) + INTERVAL '1 month'
               ),
               0
             )::int AS month_devices_sold,
             COALESCE(
               SUM(COALESCE(final_total, total_amount)) FILTER (
                 WHERE payment_date IS NOT NULL
                   AND payment_date >= date_trunc('month', CURRENT_TIMESTAMP)
                   AND payment_date < date_trunc('month', CURRENT_TIMESTAMP) + INTERVAL '1 month'
               ),
               0
             )::numeric(12,2) AS month_revenue
           FROM orders
           WHERE payment_status = 'Paid'
             AND COALESCE(order_status, '') <> 'Cancelled'`
        );

        const stats = rows[0] || {};
        return res.status(200).json({
          success: true,
          devicesSold: Number(stats.devices_sold || 0),
          revenueReceived: Number(stats.revenue_received || 0),
          todayDevicesSold: Number(stats.today_devices_sold || 0),
          todayRevenue: Number(stats.today_revenue || 0),
          monthDevicesSold: Number(stats.month_devices_sold || 0),
          monthRevenue: Number(stats.month_revenue || 0),
        });
      } catch (fallbackError) {
        console.error("Dashboard stats fallback error:", {
          message: fallbackError?.message,
          code: fallbackError?.code,
        });
      }
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}
