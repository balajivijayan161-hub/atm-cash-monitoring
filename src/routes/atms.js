const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage, intOrNull, likePattern, pageWindow } = require('../http');
const { scopeBinds, atmScopeSql } = require('../auth/permissions');
const { requireCan, deny } = require('../auth/gate');

const router = express.Router();
router.use(requireCan('atms'));
const STATUSES = ['active', 'cash_out', 'out_of_service', 'decommissioned'];
const PAGE_SIZE = 25;

router.get('/atms', asyncRoute(async (req, res) => {
  const locationId = intOrNull(req.query.location_id);
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const pattern = q ? likePattern(q) : null;
  const filters = [locationId, status || null, pattern, ...scopeBinds(req.user)];
  const where = `
    WHERE ($1::int IS NULL OR l.location_id = $1)
      AND ($2::text IS NULL OR a.status = $2)
      AND (
        $3::text IS NULL
        OR a.atm_code ILIKE $3 ESCAPE '\\'
        OR a.site_name ILIKE $3 ESCAPE '\\'
        OR b.branch_name ILIKE $3 ESCAPE '\\'
      )
      AND a.atm_id IN (${atmScopeSql(4)})`;
  const [count, locations] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS total
       FROM atms a
       JOIN branches b ON b.branch_id = a.branch_id
       JOIN locations l ON l.location_id = b.location_id
       ${where}`,
      filters
    ),
    query('SELECT location_id, location_name FROM locations ORDER BY location_name'),
  ]);
  const total = count.rows[0].total;
  const window = pageWindow(req.query.page, PAGE_SIZE, total);
  const rows = await query(
    `SELECT a.atm_id, a.atm_code, a.site_name, a.status, a.current_cash, a.capacity_amount,
            b.branch_name, l.location_name, l.city, d.downtime_pct
     FROM atms a
     JOIN branches b ON b.branch_id = a.branch_id
     JOIN locations l ON l.location_id = b.location_id
     LEFT JOIN v_atm_downtime_mtd d ON d.atm_id = a.atm_id
     ${where}
     ORDER BY a.atm_code
     LIMIT $8 OFFSET $9`,
    [...filters, window.pageSize, window.offset]
  );
  renderPage(req, res, 'atms', {
    title: 'ATMs',
    rows: rows.rows,
    locations: locations.rows,
    total,
    page: window.page,
    pages: window.pages,
    filters: { location_id: locationId || '', status, q },
  });
}));

router.get('/atms/:id', asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return renderPage(req, res, 'not-found', { title: 'ATM Not Found', statusCode: 404 });
  const exists = await query('SELECT 1 FROM atms WHERE atm_id = $1', [id]);
  if (!exists.rowCount) return renderPage(req, res, 'not-found', { title: 'ATM Not Found', statusCode: 404 });
  const allowed = await query(
    `SELECT 1 FROM atms a WHERE a.atm_id = $1 AND a.atm_id IN (${atmScopeSql(2)})`,
    [id, ...scopeBinds(req.user)]
  );
  if (!allowed.rowCount) return deny(req, res);
  const atm = await query(
    `SELECT a.*, b.branch_name, b.branch_code, b.address AS branch_address, b.ifsc_code,
            l.location_name, l.city, l.state, l.region, d.downtime_pct, d.downtime_minutes, d.elapsed_minutes
     FROM atms a
     JOIN branches b ON b.branch_id = a.branch_id
     JOIN locations l ON l.location_id = b.location_id
     LEFT JOIN v_atm_downtime_mtd d ON d.atm_id = a.atm_id
     WHERE a.atm_id = $1`,
    [id]
  );
  if (!atm.rowCount) return renderPage(req, res, 'not-found', { title: 'ATM Not Found', statusCode: 404 });
  const [forecast, withdrawals, tickets, downtime, loads] = await Promise.all([
    query(
      `SELECT day::date::text AS day, forecast_cash($1, day::date) AS forecast
       FROM generate_series(CURRENT_DATE, CURRENT_DATE + 6, interval '1 day') AS day`,
      [id]
    ),
    query(
      `SELECT withdrawal_date::text AS withdrawal_date, amount, txn_count, source
       FROM daily_withdrawals
       WHERE atm_id = $1
       ORDER BY withdrawal_date DESC
       LIMIT 21`,
      [id]
    ),
    query(
      `SELECT ticket_id, ticket_no, title, category, priority, status, opened_at
       FROM fault_tickets
       WHERE atm_id = $1
       ORDER BY opened_at DESC
       LIMIT 8`,
      [id]
    ),
    query(
      `SELECT started_at, ended_at, reason, notes
       FROM downtime_log
       WHERE atm_id = $1
       ORDER BY started_at DESC
       LIMIT 8`,
      [id]
    ),
    query(
      `SELECT rr.planned_date::text AS planned_date, rr.status, cv.van_code, cl.cassette_number,
              cl.denomination, cl.note_count, cl.amount
       FROM cassette_loads cl
       JOIN replenishment_runs rr ON rr.run_id = cl.run_id
       JOIN cash_vans cv ON cv.van_id = rr.van_id
       WHERE cl.atm_id = $1
       ORDER BY rr.planned_date DESC, cl.cassette_number
       LIMIT 12`,
      [id]
    ),
  ]);
  renderPage(req, res, 'atm-detail', {
    title: atm.rows[0].atm_code,
    atm: atm.rows[0],
    forecast: forecast.rows,
    withdrawals: withdrawals.rows,
    tickets: tickets.rows,
    downtime: downtime.rows,
    loads: loads.rows,
  });
}));

module.exports = router;
