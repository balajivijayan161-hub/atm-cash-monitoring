const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage, intOrNull } = require('../http');

const router = express.Router();
const STATUSES = ['open', 'assigned', 'closed'];
const CATEGORIES = ['cash_variance', 'cash_out', 'hardware', 'communication', 'cassette_error'];

router.get('/tickets', asyncRoute(async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : '';
  const [rows, engineers] = await Promise.all([
    query(
      `SELECT ft.ticket_id, ft.ticket_no, ft.title, ft.category, ft.priority, ft.status, ft.source,
              ft.opened_at, ft.closed_at, a.atm_id, a.atm_code, a.site_name, l.location_name,
              e.full_name AS engineer_name
       FROM fault_tickets ft
       JOIN atms a ON a.atm_id = ft.atm_id
       JOIN branches b ON b.branch_id = a.branch_id
       JOIN locations l ON l.location_id = b.location_id
       LEFT JOIN engineers e ON e.engineer_id = ft.engineer_id
       WHERE ($1::text IS NULL OR ft.status = $1)
         AND ($2::text IS NULL OR ft.category = $2)
       ORDER BY CASE ft.status WHEN 'open' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END,
                ft.opened_at DESC
       LIMIT 80`,
      [status || null, category || null]
    ),
    query(`SELECT engineer_id, full_name, specialty FROM engineers WHERE active ORDER BY full_name`),
  ]);
  renderPage(req, res, 'tickets', {
    title: 'Fault tickets',
    rows: rows.rows,
    engineers: engineers.rows,
    filters: { status, category },
    statuses: STATUSES,
    categories: CATEGORIES,
  });
}));

router.post('/tickets/:id/assign', asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  const engineerId = intOrNull(req.body.engineer_id);
  if (!id || !engineerId) return res.redirect('/tickets?warning=Choose an engineer before assigning the ticket.');
  const result = await query(
    `UPDATE fault_tickets
     SET engineer_id = $2,
         status = 'assigned',
         assigned_at = COALESCE(assigned_at, CURRENT_TIMESTAMP)
     WHERE ticket_id = $1
       AND status <> 'closed'
       AND EXISTS (SELECT 1 FROM engineers WHERE engineer_id = $2 AND active)
     RETURNING ticket_no`,
    [id, engineerId]
  );
  if (!result.rowCount) {
    return res.redirect('/tickets?warning=That ticket could not be assigned. It may already be closed.');
  }
  res.redirect(`/tickets?notice=${encodeURIComponent(result.rows[0].ticket_no + ' assigned.')}`);
}));

router.post('/tickets/:id/close', asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return res.redirect('/tickets?warning=That ticket was not found.');
  const resolution = String(req.body.resolution || '').trim().slice(0, 2000);
  const result = await query(
    `UPDATE fault_tickets
     SET status = 'closed',
         closed_at = CURRENT_TIMESTAMP,
         resolution = NULLIF($2, '')
     WHERE ticket_id = $1 AND status <> 'closed'
     RETURNING ticket_no`,
    [id, resolution]
  );
  if (!result.rowCount) return res.redirect('/tickets?warning=That ticket is already closed.');
  res.redirect(`/tickets?notice=${encodeURIComponent(result.rows[0].ticket_no + ' closed.')}`);
}));

module.exports = router;
