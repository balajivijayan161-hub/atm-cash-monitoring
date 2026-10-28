const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage, pageWindow, isIsoDate, exactDateTime } = require('../http');
const { requireCan } = require('../auth/gate');
const { roleLabel } = require('../auth/permissions');

const router = express.Router();
const PAGE_SIZE = 40;

function filtersFrom(req) {
  const userId = req.query.user ? Number(req.query.user) : null;
  const role = typeof req.query.role === 'string' ? req.query.role : '';
  const kind = ['session', 'access', 'change'].includes(req.query.kind) ? req.query.kind : '';
  const from = isIsoDate(req.query.from || '') ? req.query.from : '';
  const to = isIsoDate(req.query.to || '') ? req.query.to : '';
  return {
    userId: Number.isInteger(userId) && userId > 0 ? userId : null,
    role,
    kind,
    from,
    to,
    region: req.user.role === 'regional_manager' ? req.user.region : null,
  };
}

const TIMELINE = `
  SELECT created_at, 'session'::text AS kind, username, role, event AS action,
         NULL::text AS entity, NULL::text AS entity_id, event AS summary, region, user_id, '[]'::jsonb AS changes
  FROM session_log
  UNION ALL
  SELECT created_at, 'access', username, role, method, page_name, record_id, path, region, user_id, '[]'::jsonb
  FROM access_log
  UNION ALL
  SELECT created_at, 'change', username, role, action, entity, entity_id, action, region, user_id, changes
  FROM change_log
`;

function whereSql() {
  return `WHERE ($1::int IS NULL OR user_id = $1)
    AND ($2::text IS NULL OR role = $2)
    AND ($3::text IS NULL OR kind = $3)
    AND ($4::timestamptz IS NULL OR created_at >= $4::date)
    AND ($5::timestamptz IS NULL OR created_at < ($5::date + 1))
    AND ($6::text IS NULL OR region = $6)`;
}

function filterParams(filters) {
  return [filters.userId, filters.role || null, filters.kind || null, filters.from || null, filters.to || null, filters.region];
}

router.get('/activity', requireCan('activity'), asyncRoute(async (req, res) => {
  const filters = filtersFrom(req);
  const params = filterParams(filters);
  const count = await query(`SELECT COUNT(*)::int AS total FROM (${TIMELINE}) activity ${whereSql()}`, params);
  const window = pageWindow(req.query.page, PAGE_SIZE, count.rows[0].total);
  const rows = await query(
    `SELECT * FROM (${TIMELINE}) activity ${whereSql()}
     ORDER BY created_at DESC
     LIMIT ${PAGE_SIZE} OFFSET ${window.offset}`,
    params
  );
  const users = await query(
    `SELECT user_id, username, full_name, role FROM users
     WHERE ($1::text IS NULL OR region = $1)
     ORDER BY username`,
    [filters.region]
  );
  renderPage(req, res, 'activity', {
    title: 'Activity',
    rows: rows.rows,
    users: users.rows,
    filters,
    page: window.page,
    pages: window.pages,
    roleLabel,
  });
}));

router.get('/activity/export', requireCan('activity'), asyncRoute(async (req, res) => {
  const filters = filtersFrom(req);
  const rows = await query(
    `SELECT * FROM (${TIMELINE}) activity ${whereSql()} ORDER BY created_at DESC LIMIT 5000`,
    filterParams(filters)
  );
  const lines = ['Time,Type,User,Role,Action,Entity,Record,Summary'];
  for (const row of rows.rows) {
    const cells = [exactDateTime(row.created_at), row.kind, row.username, row.role, row.action, row.entity, row.entity_id, row.summary]
      .map((value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`);
    lines.push(cells.join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="activity.csv"');
  res.send(lines.join('\n'));
}));

module.exports = router;
