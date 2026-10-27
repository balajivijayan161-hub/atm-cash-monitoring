const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage, intOrNull } = require('../http');
const { lastEightWeeks } = require('../lib/windows');

const router = express.Router();
const WEEKDAY_KEYS = [
  ['mon', 1],
  ['tue', 2],
  ['wed', 3],
  ['thu', 4],
  ['fri', 5],
  ['sat', 6],
  ['sun', 0],
];

router.get('/reports/downtime-atms', asyncRoute(async (req, res) => {
  const [rows, bounds] = await Promise.all([
    query(`SELECT *
           FROM v_atm_downtime_above_5pct
           ORDER BY downtime_pct DESC, atm_code`),
    query(`SELECT date_trunc('month', CURRENT_TIMESTAMP) AS month_start, CURRENT_TIMESTAMP AS period_end`),
  ]);
  renderPage(req, res, 'report-downtime-atms', {
    title: 'Downtime above 5%',
    rows: rows.rows,
    monthStart: bounds.rows[0].month_start,
    periodEnd: bounds.rows[0].period_end,
  });
}));

router.get('/reports/van-cashouts', asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT * FROM v_van_cashout_incidents ORDER BY cashout_incidents DESC, van_code`
  );
  const max = rows.rows.reduce((top, row) => Math.max(top, Number(row.cashout_incidents) || 0), 0);
  renderPage(req, res, 'report-van-cashouts', { title: 'Van cash-out incidents', rows: rows.rows, max });
}));

router.get('/reports/withdrawal-matrix', asyncRoute(async (req, res) => {
  const locations = await query('SELECT location_id, location_name, city FROM locations ORDER BY location_name');
  const requested = intOrNull(req.query.location_id);
  const locationId = requested || locations.rows[0]?.location_id || null;
  let rows = [];
  if (locationId) {
    const selectDays = WEEKDAY_KEYS.map(([key, dow]) =>
      `COALESCE(SUM(w.amount) FILTER (WHERE EXTRACT(DOW FROM w.withdrawal_date) = ${dow}), 0) AS ${key}`
    ).join(',\n');
    const result = await query(
      `SELECT a.atm_id, a.atm_code, a.site_name,
              ${selectDays}
       FROM atms a
       JOIN branches b ON b.branch_id = a.branch_id
       LEFT JOIN daily_withdrawals w
         ON w.atm_id = a.atm_id
        AND ${lastEightWeeks('w.withdrawal_date')}
       WHERE b.location_id = $1
       GROUP BY a.atm_id
       ORDER BY a.atm_code`,
      [locationId]
    );
    rows = result.rows;
  }
  let max = 0;
  const totals = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };
  for (const row of rows) {
    for (const [key] of WEEKDAY_KEYS) {
      totals[key] += Number(row[key]) || 0;
      max = Math.max(max, Number(row[key]) || 0);
    }
  }
  renderPage(req, res, 'report-matrix', {
    title: 'Withdrawals by ATM and weekday',
    locations: locations.rows,
    locationId,
    rows,
    totals,
    max,
    keys: WEEKDAY_KEYS.map(([key]) => key),
  });
}));

router.get('/reports/downtime-by-location', asyncRoute(async (req, res) => {
  const [summary, reasons] = await Promise.all([
    query(`SELECT location_id, location_name, city, region,
                  COUNT(*)::int AS atms,
                  ROUND(AVG(downtime_pct)::numeric, 2) AS avg_downtime_pct,
                  ROUND((100 - AVG(downtime_pct))::numeric, 2) AS uptime_pct,
                  ROUND(SUM(downtime_minutes)::numeric, 0) AS downtime_minutes,
                  COUNT(*) FILTER (WHERE downtime_pct > 5)::int AS atms_above_5
           FROM v_atm_downtime_mtd
           GROUP BY location_id, location_name, city, region
           ORDER BY avg_downtime_pct DESC, location_name`),
    query(`SELECT l.location_name, d.reason,
                  ROUND(SUM(
                    GREATEST(EXTRACT(EPOCH FROM (
                      LEAST(COALESCE(d.ended_at, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
                      - GREATEST(d.started_at, date_trunc('month', CURRENT_TIMESTAMP))
                    )) / 60.0, 0)
                  )::numeric, 0) AS minutes
           FROM downtime_log d
           JOIN atms a ON a.atm_id = d.atm_id
           JOIN branches b ON b.branch_id = a.branch_id
           JOIN locations l ON l.location_id = b.location_id
           WHERE d.started_at < CURRENT_TIMESTAMP
             AND COALESCE(d.ended_at, CURRENT_TIMESTAMP) > date_trunc('month', CURRENT_TIMESTAMP)
           GROUP BY l.location_name, l.location_id, d.reason
           ORDER BY l.location_name, minutes DESC`),
  ]);
  const maxDowntime = summary.rows.reduce((top, row) => Math.max(top, Number(row.avg_downtime_pct) || 0), 0);
  renderPage(req, res, 'report-downtime-location', {
    title: 'Downtime by location',
    summary: summary.rows,
    reasons: reasons.rows,
    maxDowntime,
  });
}));

module.exports = router;
