const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage } = require('../http');
const { lastEightWeeks } = require('../lib/windows');
const { getSimulatorStatus } = require('../services/simulator');

const router = express.Router();

router.get('/', asyncRoute(async (req, res) => {
  const [fleet, tickets, runs, dispensed, byLocation, byDay, byWeekday, worst, recentTickets, alerts, downtimeOpen] = await Promise.all([
    query(`SELECT
             COUNT(*)::int AS atms,
             ROUND(AVG(downtime_pct)::numeric, 2) AS avg_downtime_pct,
             COUNT(*) FILTER (WHERE downtime_pct > 5)::int AS above_five,
             COUNT(*) FILTER (WHERE status = 'cash_out')::int AS cash_out,
             COUNT(*) FILTER (WHERE status = 'out_of_service')::int AS out_of_service
           FROM v_atm_downtime_mtd`),
    query(`SELECT
             COUNT(*) FILTER (WHERE status <> 'closed')::int AS open_tickets,
             COUNT(*) FILTER (WHERE source = 'trigger' AND status <> 'closed')::int AS open_variances
           FROM fault_tickets`),
    query(`SELECT
             COUNT(*) FILTER (WHERE planned_date = CURRENT_DATE AND status <> 'cancelled')::int AS today_runs,
             COUNT(*) FILTER (WHERE planned_date = CURRENT_DATE + 1 AND status = 'planned')::int AS tomorrow_planned
           FROM replenishment_runs`),
    query(`SELECT COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(txn_count), 0)::int AS txns
           FROM daily_withdrawals
           WHERE withdrawal_date = CURRENT_DATE - 1`),
    query(`SELECT location_name,
                  ROUND(AVG(downtime_pct)::numeric, 2) AS downtime_pct,
                  ROUND((100 - AVG(downtime_pct))::numeric, 2) AS uptime_pct
           FROM v_atm_downtime_mtd
           GROUP BY location_id, location_name
           ORDER BY location_name`),
    query(`SELECT to_char(gs::date, 'YYYY-MM-DD') AS day,
                  COALESCE(ROUND(SUM(
                    CASE
                      WHEN d.downtime_id IS NULL THEN 0
                      ELSE GREATEST(EXTRACT(EPOCH FROM (
                        LEAST(COALESCE(d.ended_at, CURRENT_TIMESTAMP), (gs::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
                        - GREATEST(d.started_at, gs::date::timestamp AT TIME ZONE 'Asia/Kolkata')
                      )) / 60.0, 0)
                    END
                  )::numeric, 0), 0) AS minutes
           FROM generate_series(CURRENT_DATE - 13, CURRENT_DATE, interval '1 day') AS gs
           LEFT JOIN downtime_log d
             ON d.started_at < ((gs::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
            AND COALESCE(d.ended_at, CURRENT_TIMESTAMP) > (gs::date::timestamp AT TIME ZONE 'Asia/Kolkata')
           GROUP BY gs
           ORDER BY gs`),
    query(`SELECT EXTRACT(DOW FROM withdrawal_date)::int AS dow, COALESCE(SUM(amount), 0) AS amount
           FROM daily_withdrawals
           WHERE ${lastEightWeeks('withdrawal_date')}
           GROUP BY 1`),
    query(`SELECT atm_id, atm_code, site_name, location_name, city, downtime_pct, status
           FROM v_atm_downtime_mtd
           ORDER BY downtime_pct DESC, atm_code
           LIMIT 8`),
    query(`SELECT ft.ticket_no, ft.title, ft.category, ft.priority, ft.status, ft.opened_at, a.atm_code, ft.ticket_id
           FROM fault_tickets ft
           JOIN atms a ON a.atm_id = ft.atm_id
           ORDER BY ft.opened_at DESC
           LIMIT 6`),
    query(`SELECT r.request_id, r.current_cash, r.capacity_amount, r.threshold_pct, r.created_at,
                  a.atm_id, a.atm_code, a.site_name
           FROM replenishment_requests r
           JOIN atms a ON a.atm_id = r.atm_id
           WHERE r.status = 'open'
           ORDER BY r.created_at DESC
           LIMIT 8`),
    query(`SELECT d.downtime_id, d.started_at, d.reason, a.atm_id, a.atm_code
           FROM downtime_log d
           JOIN atms a ON a.atm_id = d.atm_id
           WHERE d.ended_at IS NULL
           ORDER BY d.started_at DESC
           LIMIT 6`),
  ]);

  const fleetRow = fleet.rows[0] || {};
  const uptime = fleetRow.avg_downtime_pct == null ? null : Math.round((100 - Number(fleetRow.avg_downtime_pct)) * 100) / 100;
  const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDow = new Map(byWeekday.rows.map((row) => [row.dow, Number(row.amount)]));

  renderPage(req, res, 'dashboard', {
    title: 'Fleet uptime',
    fleet: fleetRow,
    uptime,
    tickets: tickets.rows[0],
    runs: runs.rows[0],
    dispensed: dispensed.rows[0],
    worst: worst.rows,
    recentTickets: recentTickets.rows,
    alerts: alerts.rows,
    downtimeOpen: downtimeOpen.rows,
    simulator: getSimulatorStatus(),
    charts: {
      locations: byLocation.rows.map((row) => row.location_name),
      uptime: byLocation.rows.map((row) => Number(row.uptime_pct)),
      days: byDay.rows.map((row) => row.day.slice(5)),
      downtimeMinutes: byDay.rows.map((row) => Number(row.minutes)),
      weekdays: weekdayOrder.map((dow) => weekdayNames[dow]),
      weekdayAmounts: weekdayOrder.map((dow) => byDow.get(dow) || 0),
    },
  });
}));

module.exports = router;
