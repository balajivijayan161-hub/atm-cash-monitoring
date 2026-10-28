const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage, intOrNull, pageWindow } = require('../http');
const { requireCan, deny, guard } = require('../auth/gate');
const { scopeBinds, atmScopeSql } = require('../auth/permissions');
const { recordChange } = require('../auth/activity');

const router = express.Router();
const PAGE_SIZE = 80;
const STATUSES = ['open', 'assigned', 'closed'];
const CATEGORIES = ['cash_variance', 'cash_out', 'hardware', 'communication', 'cassette_error'];

router.get('/tickets', asyncRoute(async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : '';
  const focusId = intOrNull(req.query.ticket);
  const filters = [status || null, category || null, ...scopeBinds(req.user)];
  const where = `WHERE ($1::text IS NULL OR ft.status = $1)
         AND ($2::text IS NULL OR ft.category = $2)
         AND ft.atm_id IN (${atmScopeSql(3)})
         AND ($6::int IS NULL OR ft.engineer_id = $6)`;
  const count = await query(
    `SELECT COUNT(*)::int AS total
     FROM fault_tickets ft
     ${where}`,
    filters
  );
  const window = pageWindow(req.query.page, PAGE_SIZE, count.rows[0].total);
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
       ${where}
       ORDER BY (ft.ticket_id = $7::int) DESC,
                CASE ft.status WHEN 'open' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END,
                ft.opened_at DESC
       LIMIT $8 OFFSET $9`,
      [...filters, focusId, PAGE_SIZE, window.offset]
    ),
    query(`SELECT engineer_id, full_name, specialty FROM engineers WHERE active ORDER BY full_name`),
  ]);
  renderPage(req, res, 'tickets', {
    title: 'Fault Tickets',
    rows: rows.rows,
    engineers: engineers.rows,
    filters: { status, category, ticket: focusId || '' },
    focusId,
    page: window.page,
    pages: window.pages,
    statuses: STATUSES,
    categories: CATEGORIES,
  });
}));

router.post('/tickets/:id/assign', requireCan('assignTickets'), asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  const engineerId = intOrNull(req.body.engineer_id);
  if (!id) return res.redirect('/tickets?warning=Ticket not found.');
  const engineerText = req.body.engineer_id == null ? '' : String(req.body.engineer_id).trim();
  if (!engineerText) return res.redirect('/tickets?warning=Choose an engineer before assigning the ticket.');
  if (!engineerId) return res.redirect('/tickets?warning=Engineer not found.');
  const ticket = await query(
    `SELECT ft.status, ft.engineer_id FROM fault_tickets ft
     WHERE ft.ticket_id = $1 AND ft.atm_id IN (${atmScopeSql(2)})`,
    [id, ...scopeBinds(req.user)]
  );
  if (!ticket.rowCount) {
    const exists = await query('SELECT 1 FROM fault_tickets WHERE ticket_id = $1', [id]);
    if (!exists.rowCount) return res.redirect('/tickets?warning=Ticket not found.');
    return deny(req, res);
  }
  if (ticket.rows[0].status === 'closed') return res.redirect('/tickets?warning=That ticket is already closed.');
  const engineer = await query('SELECT 1 FROM engineers WHERE engineer_id = $1 AND active', [engineerId]);
  if (!engineer.rowCount) return res.redirect('/tickets?warning=Engineer not found.');
  const result = await query(
    `UPDATE fault_tickets
     SET engineer_id = $2,
         status = 'assigned',
         assigned_at = COALESCE(assigned_at, CURRENT_TIMESTAMP),
         responded_at = COALESCE(responded_at, CURRENT_TIMESTAMP)
     WHERE ticket_id = $1
       AND status <> 'closed'
     RETURNING ticket_no`,
    [id, engineerId]
  );
  if (!result.rowCount) return res.redirect('/tickets?warning=That ticket is already closed.');
  await recordChange(req, {
    action: 'update',
    entity: 'fault ticket',
    entityId: id,
    before: { status: ticket.rows[0].status },
    after: { status: 'assigned', engineer_id: engineerId },
  });
  res.redirect(`/tickets?notice=${encodeURIComponent(result.rows[0].ticket_no + ' assigned.')}`);
}));

router.post('/tickets/:id/close', asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return res.redirect('/tickets?warning=Ticket not found.');
  const ticket = await query(
    `SELECT ft.status, ft.engineer_id FROM fault_tickets ft
     WHERE ft.ticket_id = $1
       AND ft.atm_id IN (${atmScopeSql(2)})
       AND ($5::int IS NULL OR ft.engineer_id = $5)`,
    [id, ...scopeBinds(req.user)]
  );
  if (!ticket.rowCount) {
    const exists = await query('SELECT 1 FROM fault_tickets WHERE ticket_id = $1', [id]);
    if (!exists.rowCount) return res.redirect('/tickets?warning=Ticket not found.');
    return deny(req, res);
  }
  if (ticket.rows[0].status === 'closed') return res.redirect('/tickets?warning=That ticket is already closed.');
  const resolution = String(req.body.resolution || '').trim().slice(0, 2000);
  const result = await query(
    `UPDATE fault_tickets
     SET status = 'closed',
         closed_at = CURRENT_TIMESTAMP,
         resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP),
         resolution = NULLIF($2, '')
     WHERE ticket_id = $1 AND status <> 'closed'
     RETURNING ticket_no`,
    [id, resolution]
  );
  if (!result.rowCount) return res.redirect('/tickets?warning=That ticket is already closed.');
  await recordChange(req, {
    action: 'update',
    entity: 'fault ticket',
    entityId: id,
    before: { status: ticket.rows[0].status },
    after: { status: 'closed', resolution: resolution || null },
  });
  res.redirect(`/tickets?notice=${encodeURIComponent(result.rows[0].ticket_no + ' closed.')}`);
}));

module.exports = guard(router, 'tickets');
