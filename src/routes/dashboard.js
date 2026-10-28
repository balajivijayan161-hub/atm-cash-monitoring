const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage } = require('../http');
const { requireCan } = require('../auth/gate');
const { scopeBinds, atmScopeSql } = require('../auth/permissions');
const { lastEightWeeks } = require('../lib/windows');
const { getSimulatorStatus } = require('../services/simulator');
const { hoursToEmpty, runsOutWithinDay } = require('../services/cashout');

const router = express.Router();

router.get('/', requireCan('dashboard'), asyncRoute(async (req, res) => {
  const [fleet, tickets, runs, dispensed, byLocation, byDay, byWeekday, worst, recentTickets, alerts, alertCount, downtimeOpen, downtimeCount, cashoutRows, slaBreaches] = await Promise.all([
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
                  LEAST(100, GREATEST(0, ROUND((100 - AVG(downtime_pct))::numeric, 2))) AS uptime_pct
           FROM v_atm_downtime_mtd
           GROUP BY location_id, location_name
           ORDER BY location_name`),
    query(`WITH days AS (
             SELECT gs::date AS day,
                    (gs::date::timestamp AT TIME ZONE 'Asia/Kolkata') AS day_start,
                    LEAST(
                      ((gs::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'),
                      CURRENT_TIMESTAMP
                    ) AS day_end
             FROM generate_series(CURRENT_DATE - 13, CURRENT_DATE, interval '1 day') AS gs
           ),
           clipped AS (
             SELECT days.day, d.atm_id, d.downtime_id,
                    GREATEST(d.started_at, days.day_start) AS started_at,
                    LEAST(COALESCE(d.ended_at, CURRENT_TIMESTAMP), days.day_end) AS ended_at
             FROM days
             JOIN downtime_log d
               ON d.started_at < days.day_end
              AND COALESCE(d.ended_at, CURRENT_TIMESTAMP) > days.day_start
           ),
           ordered AS (
             SELECT day, atm_id, downtime_id, started_at, ended_at,
                    MAX(ended_at) OVER (
                      PARTITION BY day, atm_id
                      ORDER BY started_at, ended_at, downtime_id
                      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                    ) AS prev_end
             FROM clipped
             WHERE ended_at > started_at
           ),
           marked AS (
             SELECT day, atm_id, downtime_id, started_at, ended_at,
                    CASE WHEN prev_end IS NULL OR started_at > prev_end THEN 1 ELSE 0 END AS new_island
             FROM ordered
           ),
           islands AS (
             SELECT day, atm_id, started_at, ended_at,
                    SUM(new_island) OVER (
                      PARTITION BY day, atm_id
                      ORDER BY started_at, ended_at, downtime_id
                      ROWS UNBOUNDED PRECEDING
                    ) AS island_id
             FROM marked
           ),
           merged AS (
             SELECT day, MIN(started_at) AS started_at, MAX(ended_at) AS ended_at
             FROM islands
             GROUP BY day, atm_id, island_id
           )
           SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
                  COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (merged.ended_at - merged.started_at)) / 60.0)::numeric, 0), 0) AS minutes
           FROM days
           LEFT JOIN merged ON merged.day = days.day
           GROUP BY days.day
           ORDER BY days.day`),
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
    query(`SELECT COUNT(*)::int AS n FROM replenishment_requests WHERE status = 'open'`),
    query(`SELECT d.downtime_id, d.started_at, d.reason, a.atm_id, a.atm_code
           FROM downtime_log d
           JOIN atms a ON a.atm_id = d.atm_id
           WHERE d.ended_at IS NULL
           ORDER BY d.started_at DESC
           LIMIT 6`),
    query(`SELECT COUNT(*)::int AS n FROM downtime_log WHERE ended_at IS NULL`),
    query(
      `SELECT a.atm_id, a.atm_code, a.site_name, a.current_cash,
              forecast_cash(a.atm_id, CURRENT_DATE + 1) AS forecast
       FROM atms a
       WHERE a.status <> 'decommissioned'
         AND a.atm_id IN (${atmScopeSql(1)})`,
      scopeBinds(req.user)
    ),
    query(`SELECT COUNT(*)::int AS n
           FROM fault_tickets ft
           JOIN sla_targets s ON s.category = sla_category(ft.category)
           WHERE ft.status <> 'closed'
             AND (
               EXTRACT(EPOCH FROM (COALESCE(ft.responded_at, CURRENT_TIMESTAMP) - ft.opened_at)) / 3600 > s.response_hours
               OR EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ft.opened_at)) / 3600 > s.resolution_hours
             )`),
  ]);

  const fleetRow = fleet.rows[0] || {};
  const uptime = fleetRow.avg_downtime_pct == null
    ? null
    : Math.round(Math.min(100, Math.max(0, 100 - Number(fleetRow.avg_downtime_pct))) * 100) / 100;
  const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDow = new Map(byWeekday.rows.map((row) => [row.dow, Number(row.amount)]));

  renderPage(req, res, 'dashboard', {
    title: 'Fleet Uptime',
    fleet: fleetRow,
    uptime,
    tickets: tickets.rows[0],
    runs: runs.rows[0],
    dispensed: dispensed.rows[0],
    worst: worst.rows,
    recentTickets: recentTickets.rows,
    alerts: alerts.rows,
    alertTotal: alertCount.rows[0].n,
    downtimeOpen: downtimeOpen.rows,
    downtimeTotal: downtimeCount.rows[0].n,
    slaBreaches: slaBreaches.rows[0].n,
    cashouts: cashoutRows.rows
      .map((row) => ({ ...row, hours: hoursToEmpty(row.current_cash, row.forecast) }))
      .filter((row) => runsOutWithinDay(row.hours))
      .sort((a, b) => a.hours - b.hours)
      .slice(0, 8),
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
