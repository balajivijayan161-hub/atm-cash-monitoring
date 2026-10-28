const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage, intOrNull, pageWindow, batchName } = require('../http');

const router = express.Router();
const PAGE_SIZE = 80;

router.get('/imports', asyncRoute(async (req, res) => {
  const count = await query('SELECT COUNT(*)::int AS total FROM switch_import_batches');
  const window = pageWindow(req.query.page, PAGE_SIZE, count.rows[0].total);
  const rows = await query(
    `SELECT batch_id, filename, source, file_format, uploaded_at, row_count, loaded_count, error_count, status
     FROM switch_import_batches
     ORDER BY uploaded_at DESC, batch_id DESC
     LIMIT $1 OFFSET $2`,
    [PAGE_SIZE, window.offset]
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
  renderPage(req, res, 'import-detail', {
    title: batchName(batch.rows[0]),
    batch: batch.rows[0],
    rows: rows.rows,
  });
}));

module.exports = router;
