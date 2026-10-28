const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage, intOrNull, pageWindow, batchName } = require('../http');

const { deny, guard } = require('../auth/gate');
const { scopeBinds, atmScopeSql } = require('../auth/permissions');
const router = express.Router();
const PAGE_SIZE = 80;

function importScope(start) {
  return `(EXISTS (
    SELECT 1 FROM switch_import_rows r
    JOIN atms a ON a.atm_code = r.atm_code
    WHERE r.batch_id = b.batch_id AND a.atm_id IN (${atmScopeSql(start)})
  ) OR NOT EXISTS (
    SELECT 1 FROM switch_import_rows r
    WHERE r.batch_id = b.batch_id AND r.atm_code IS NOT NULL
  ))`;
}

router.get('/imports', asyncRoute(async (req, res) => {
  const scope = scopeBinds(req.user);
  const count = await query(
    `SELECT COUNT(*)::int AS total FROM switch_import_batches b WHERE ${importScope(1)}`,
    scope
  );
  const window = pageWindow(req.query.page, PAGE_SIZE, count.rows[0].total);
  const rows = await query(
    `SELECT batch_id, filename, source, file_format, uploaded_at, row_count, loaded_count, error_count, status
     FROM switch_import_batches b
     WHERE ${importScope(1)}
     ORDER BY uploaded_at DESC, batch_id DESC
     LIMIT $5 OFFSET $6`,
    [...scope, PAGE_SIZE, window.offset]
  );
  renderPage(req, res, 'imports', {
    title: 'Import History',
    rows: rows.rows,
    page: window.page,
    pages: window.pages,
  });
}));

router.get('/imports/:id', asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return renderPage(req, res, 'not-found', { title: 'Import Not Found', statusCode: 404 });
  const [batch, rows] = await Promise.all([
    query(
      `SELECT batch_id, filename, source, file_format, uploaded_at, row_count, loaded_count, error_count, status
       FROM switch_import_batches WHERE batch_id = $1`,
      [id]
    ),
    query(
      `SELECT line_no, atm_code, txn_date::text AS txn_date, amount, txn_count, status, error_message
       FROM switch_import_rows
       WHERE batch_id = $1
       ORDER BY line_no`,
      [id]
    ),
  ]);
  if (!batch.rowCount) return renderPage(req, res, 'not-found', { title: 'Import Not Found', statusCode: 404 });
  const visible = await query(
    `SELECT 1 FROM switch_import_batches b WHERE b.batch_id = $1 AND ${importScope(2)}`,
    [id, ...scopeBinds(req.user)]
  );
  if (!visible.rowCount) return deny(req, res);
  renderPage(req, res, 'import-detail', {
    title: batchName(batch.rows[0]),
    batch: batch.rows[0],
    rows: rows.rows,
  });
}));

module.exports = guard(router, 'importData');
