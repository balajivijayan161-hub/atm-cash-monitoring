const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage, pageWindow } = require('../http');
const { requireCan } = require('../auth/gate');

const router = express.Router();
const PAGE_SIZE = 80;

router.get('/alerts', requireCan('alerts'), asyncRoute(async (req, res) => {
  const count = await query(`SELECT COUNT(*)::int AS total FROM replenishment_requests WHERE status = 'open'`);
  const window = pageWindow(req.query.page, PAGE_SIZE, count.rows[0].total);
  const rows = await query(
    `SELECT r.request_id, r.current_cash, r.capacity_amount, r.threshold_pct, r.created_at,
            a.atm_id, a.atm_code, a.site_name, l.location_name
     FROM replenishment_requests r
     JOIN atms a ON a.atm_id = r.atm_id
     JOIN branches b ON b.branch_id = a.branch_id
     JOIN locations l ON l.location_id = b.location_id
     WHERE r.status = 'open'
     ORDER BY r.created_at DESC
     LIMIT $1 OFFSET $2`,
    [PAGE_SIZE, window.offset]
  );
  renderPage(req, res, 'alerts', {
    title: 'Cash Alerts',
    rows: rows.rows,
    page: window.page,
    pages: window.pages,
  });
}));

router.get('/downtime', requireCan('downtime'), asyncRoute(async (req, res) => {
  const count = await query(`SELECT COUNT(*)::int AS total FROM downtime_log WHERE ended_at IS NULL`);
  const window = pageWindow(req.query.page, PAGE_SIZE, count.rows[0].total);
  const rows = await query(
    `SELECT d.downtime_id, d.started_at, d.reason, d.notes, a.atm_id, a.atm_code, a.site_name, l.location_name
     FROM downtime_log d
     JOIN atms a ON a.atm_id = d.atm_id
     JOIN branches b ON b.branch_id = a.branch_id
     JOIN locations l ON l.location_id = b.location_id
     WHERE d.ended_at IS NULL
     ORDER BY d.started_at DESC
     LIMIT $1 OFFSET $2`,
    [PAGE_SIZE, window.offset]
  );
  renderPage(req, res, 'downtime-open', {
    title: 'Open Downtime',
    rows: rows.rows,
    page: window.page,
    pages: window.pages,
  });
}));

module.exports = router;
