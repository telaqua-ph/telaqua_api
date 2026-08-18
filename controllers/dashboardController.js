/**
 * Dashboard operations + sales metrics.
 * Admin-only aggregated stats sourced from backend-confirmed paid orders.
 */

import { query } from "../config/db.js";

function emptyAnalysis(from = null, to = null) {
  return {
    from,
    to,
    devicesSold: 0,
    revenueReceived: 0,
    averageRevenuePerDevice: 0,
  };
}

function normalizeDateInput(raw) {
  const value = String(raw || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function parseRange(req) {
  const from = normalizeDateInput(req.query.from);
  const to = normalizeDateInput(req.query.to);
  if (from && to && from > to) {
    return { error: "The from date must be earlier than or equal to the to date." };
  }
  return { from, to };
}

function mapStatsRow(row, from, to) {
  return {
    totalOrders: Number(row.total_orders || 0),
    newOrders: Number(row.new_orders || 0),
    paidOrders: Number(row.paid_orders || 0),
    pendingPayments: Number(row.pending_payments || 0),
    shipmentsCreated: Number(row.shipments_created || 0),
    unseenOrders: Number(row.unseen_orders || 0),
    devicesSold: Number(row.devices_sold || 0),
    revenueReceived: Number(row.revenue_received || 0),
    todayDevicesSold: Number(row.today_devices_sold || 0),
    todayRevenue: Number(row.today_revenue || 0),
    monthDevicesSold: Number(row.month_devices_sold || 0),
    monthRevenue: Number(row.month_revenue || 0),
    analysis: {
      from,
      to,
      devicesSold: Number(row.analysis_devices_sold || 0),
      revenueReceived: Number(row.analysis_revenue_received || 0),
      averageRevenuePerDevice: Number(row.analysis_average_revenue_per_device || 0),
    },
  };
}

async function fetchDashboardStats({ adminId, from, to, includeIsTestOrder = true, includeViews = true }) {
  const params = [adminId, from, to];
  const paidTestFilter = includeIsTestOrder
    ? "AND COALESCE(is_test_order, FALSE) = FALSE"
    : "";
  const unseenJoin = includeViews
    ? `LEFT JOIN admin_order_views aov
         ON aov.order_id = o.id
        AND aov.admin_id = $1`
    : "";
  const unseenPredicate = includeViews ? "aov.order_id IS NULL" : "FALSE";

  const { rows } = await query(
    `WITH order_rows AS (
       SELECT
         o.*,
         ${includeViews ? "aov.first_viewed_at IS NOT NULL" : "FALSE"} AS is_seen
       FROM orders o
       ${unseenJoin}
     ),
     operational AS (
       SELECT
         COUNT(*)::int AS total_orders,
         COUNT(*) FILTER (
           WHERE LOWER(COALESCE(order_status, '')) IN ('new', 'pending')
         )::int AS new_orders,
         COUNT(*) FILTER (
           WHERE COALESCE(payment_status, '') = 'Paid'
         )::int AS paid_orders,
         COUNT(*) FILTER (
           WHERE COALESCE(payment_status, '') = 'Pending'
         )::int AS pending_payments,
         COUNT(*) FILTER (
           WHERE COALESCE(NULLIF(TRIM(waybill), ''), NULL) IS NOT NULL
              OR LOWER(COALESCE(shipment_status, '')) NOT IN ('', 'not created')
         )::int AS shipments_created,
         COUNT(*) FILTER (
           WHERE ${unseenPredicate}
         )::int AS unseen_orders
       FROM order_rows o
     ),
     paid_orders AS (
       SELECT *
       FROM orders
       WHERE payment_status = 'Paid'
         AND COALESCE(order_status, '') <> 'Cancelled'
         ${paidTestFilter}
     ),
     sales AS (
       SELECT
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
       FROM paid_orders
     ),
     analysis AS (
       SELECT
         COALESCE(SUM(quantity), 0)::int AS analysis_devices_sold,
         COALESCE(SUM(COALESCE(final_total, total_amount)), 0)::numeric(12,2) AS analysis_revenue_received
       FROM paid_orders
       WHERE ($2::date IS NULL OR payment_date >= $2::date)
         AND ($3::date IS NULL OR payment_date < ($3::date + INTERVAL '1 day'))
     )
     SELECT
       operational.*,
       sales.*,
       analysis.analysis_devices_sold,
       analysis.analysis_revenue_received,
       CASE
         WHEN analysis.analysis_devices_sold > 0
           THEN ROUND(analysis.analysis_revenue_received / analysis.analysis_devices_sold, 2)
         ELSE 0
       END::numeric(12,2) AS analysis_average_revenue_per_device
     FROM operational
     CROSS JOIN sales
     CROSS JOIN analysis`,
    params
  );

  return rows[0] || null;
}

export async function getStats(req, res) {
  const adminId = Number(req.user?.admin_id || req.user?.id);
  if (!Number.isInteger(adminId) || adminId <= 0) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  const range = parseRange(req);
  if (range.error) {
    return res.status(400).json({
      success: false,
      message: range.error,
    });
  }

  const { from, to } = range;

  try {
    const stats = await fetchDashboardStats({
      adminId,
      from,
      to,
      includeIsTestOrder: true,
      includeViews: true,
    });

    if (!stats) {
      return res.status(200).json({
        success: true,
        totalOrders: 0,
        newOrders: 0,
        paidOrders: 0,
        pendingPayments: 0,
        shipmentsCreated: 0,
        unseenOrders: 0,
        devicesSold: 0,
        revenueReceived: 0,
        todayDevicesSold: 0,
        todayRevenue: 0,
        monthDevicesSold: 0,
        monthRevenue: 0,
        analysis: emptyAnalysis(from, to),
      });
    }

    return res.status(200).json({
      success: true,
      ...mapStatsRow(stats, from, to),
    });
  } catch (error) {
    console.error("Dashboard stats error:", {
      message: error?.message,
      code: error?.code,
    });

    const missingIsTestOrder =
      error?.code === "42703" &&
      String(error?.message || "").includes("is_test_order");
    const missingOrderViews =
      error?.code === "42P01" &&
      String(error?.message || "").includes("admin_order_views");

    if (missingIsTestOrder || missingOrderViews) {
      try {
        const stats = await fetchDashboardStats({
          adminId,
          from,
          to,
          includeIsTestOrder: !missingIsTestOrder,
          includeViews: !missingOrderViews,
        });

        return res.status(200).json({
          success: true,
          ...(stats
            ? mapStatsRow(stats, from, to)
            : {
                totalOrders: 0,
                newOrders: 0,
                paidOrders: 0,
                pendingPayments: 0,
                shipmentsCreated: 0,
                unseenOrders: 0,
                devicesSold: 0,
                revenueReceived: 0,
                todayDevicesSold: 0,
                todayRevenue: 0,
                monthDevicesSold: 0,
                monthRevenue: 0,
                analysis: emptyAnalysis(from, to),
              }),
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
