const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage, intOrNull } = require('../http');
const { requireCan, deny } = require('../auth/gate');
const { scopeBinds, atmScopeSql } = require('../auth/permissions');
const { recordChange } = require('../auth/activity');
const { lastEightWeeks } = require('../lib/windows');

const router = express.Router();
router.use(requireCan('reports'));
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
           WHERE atm_id IN (${atmScopeSql(1)})
           ORDER BY downtime_pct DESC, atm_code`, scopeBinds(req.user)),
    query(`SELECT date_trunc('month', CURRENT_TIMESTAMP) AS month_start, CURRENT_TIMESTAMP AS period_end`),
  ]);
  renderPage(req, res, 'report-downtime-atms', {
    title: 'Downtime Above 5%',
    rows: rows.rows,
    monthStart: bounds.rows[0].month_start,
    periodEnd: bounds.rows[0].period_end,
  });
}));

router.get('/reports/van-cashouts', asyncRoute(async (req, res) => {
  const [region, branchId, custodianId, engineerId] = scopeBinds(req.user);
  const rows = await query(
    `SELECT * FROM v_van_cashout_incidents
     WHERE ($1::text IS NULL OR location_id IN (SELECT location_id FROM locations WHERE region = $1))
       AND ($2::int IS NULL OR location_id = (SELECT location_id FROM branches WHERE branch_id = $2))
       AND ($3::int IS NULL)
       AND ($4::int IS NULL)
     ORDER BY cashout_incidents DESC, van_code`,
    [region, branchId, custodianId, engineerId]
  );
  const max = rows.rows.reduce((top, row) => Math.max(top, Number(row.cashout_incidents) || 0), 0);
  renderPage(req, res, 'report-van-cashouts', { title: 'Van Cash-Outs', rows: rows.rows, max });
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
    title: 'Withdrawal Matrix',
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
    title: 'Downtime by Location',
    summary: summary.rows,
    reasons: reasons.rows,
    maxDowntime,
  });
}));

router.get('/reports/sla', asyncRoute(async (req, res) => {
  const [targets, byCategory, byLocation, byEngineer] = await Promise.all([
    query('SELECT category, response_hours, resolution_hours FROM sla_targets ORDER BY category'),
    query(`SELECT sla_category(ft.category) AS category,
                  COUNT(*)::int AS tickets,
                  COUNT(*) FILTER (WHERE
                    EXTRACT(EPOCH FROM (COALESCE(ft.responded_at, CASE WHEN ft.status = 'closed' THEN ft.closed_at ELSE CURRENT_TIMESTAMP END) - ft.opened_at)) / 3600
                      > s.response_hours
                    OR EXTRACT(EPOCH FROM (COALESCE(ft.resolved_at, ft.closed_at, CURRENT_TIMESTAMP) - ft.opened_at)) / 3600
                      > s.resolution_hours
                  )::int AS breaches
           FROM fault_tickets ft
           JOIN sla_targets s ON s.category = sla_category(ft.category)
           GROUP BY 1
           ORDER BY 1`),
    query(`SELECT l.location_name,
                  COUNT(*)::int AS tickets,
                  COUNT(*) FILTER (WHERE
                    EXTRACT(EPOCH FROM (COALESCE(ft.resolved_at, ft.closed_at, CURRENT_TIMESTAMP) - ft.opened_at)) / 3600
                      > s.resolution_hours
                  )::int AS breaches
           FROM fault_tickets ft
           JOIN sla_targets s ON s.category = sla_category(ft.category)
           JOIN atms a ON a.atm_id = ft.atm_id
           JOIN branches b ON b.branch_id = a.branch_id
           JOIN locations l ON l.location_id = b.location_id
           GROUP BY l.location_name
           ORDER BY breaches DESC, l.location_name
           LIMIT 20`),
    query(`SELECT COALESCE(e.full_name, 'Unassigned') AS engineer_name,
                  COUNT(*)::int AS tickets,
                  COUNT(*) FILTER (WHERE
                    EXTRACT(EPOCH FROM (COALESCE(ft.resolved_at, ft.closed_at, CURRENT_TIMESTAMP) - ft.opened_at)) / 3600
                      > s.resolution_hours
                  )::int AS breaches
           FROM fault_tickets ft
           JOIN sla_targets s ON s.category = sla_category(ft.category)
           LEFT JOIN engineers e ON e.engineer_id = ft.engineer_id
           GROUP BY e.full_name
           ORDER BY breaches DESC, engineer_name
           LIMIT 20`),
  ]);
  renderPage(req, res, 'sla-report', {
    title: 'SLA Report',
    targets: targets.rows,
    byCategory: byCategory.rows,
    byLocation: byLocation.rows,
    byEngineer: byEngineer.rows,
    canEdit: req.user.role === 'super_admin',
  });
}));

router.post('/reports/sla', asyncRoute(async (req, res) => {
  if (req.user.role !== 'super_admin') return deny(req, res);
  const category = String(req.body.category || '');
  const responseHours = Number(req.body.response_hours);
  const resolutionHours = Number(req.body.resolution_hours);
  const known = await query('SELECT response_hours, resolution_hours FROM sla_targets WHERE category = $1', [category]);
  if (!known.rowCount) return res.redirect('/reports/sla?warning=Choose a category.');
  if (!(responseHours > 0) || !(resolutionHours > 0)) {
    return res.redirect('/reports/sla?warning=Enter hours greater than zero.');
  }
  await query(
    `UPDATE sla_targets SET response_hours = $2, resolution_hours = $3 WHERE category = $1`,
    [category, responseHours, resolutionHours]
  );
  await recordChange(req, {
    action: 'update',
    entity: 'sla target',
    entityId: category,
    before: known.rows[0],
    after: { response_hours: responseHours, resolution_hours: resolutionHours },
  });
  res.redirect('/reports/sla?notice=SLA target updated.');
}));

router.get('/reports/recon-ageing', asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT r.reconciliation_id, r.case_status, r.created_at, r.difference,
            a.atm_code, l.location_name,
            GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - r.created_at)) / 86400)::int AS age_days
     FROM reconciliations r
     JOIN atms a ON a.atm_id = r.atm_id
     JOIN branches b ON b.branch_id = a.branch_id
     JOIN locations l ON l.location_id = b.location_id
     WHERE r.case_status IN ('raised', 'investigating')
     ORDER BY r.created_at`
  );
  const buckets = { under2: 0, under7: 0, under14: 0, older: 0 };
  for (const row of rows.rows) {
    if (row.age_days < 2) buckets.under2 += 1;
    else if (row.age_days < 7) buckets.under7 += 1;
    else if (row.age_days < 14) buckets.under14 += 1;
    else buckets.older += 1;
  }
  renderPage(req, res, 'recon-ageing', { title: 'Open Case Ageing', rows: rows.rows, buckets });
}));

module.exports = router;
