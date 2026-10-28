const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage, intOrNull } = require('../http');

const router = express.Router();

router.get('/imports', asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT batch_id, filename, source, file_format, uploaded_at, row_count, loaded_count, error_count, status
     FROM switch_import_batches
     ORDER BY uploaded_at DESC, batch_id DESC
     LIMIT 80`
  );
  renderPage(req, res, 'imports', {
    title: 'Import history',
    rows: rows.rows,
  });
}));

router.get('/imports/:id', asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return renderPage(req, res, 'not-found', { title: 'Import not found', statusCode: 404 });
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
  if (!batch.rowCount) return renderPage(req, res, 'not-found', { title: 'Import not found', statusCode: 404 });
  renderPage(req, res, 'import-detail', {
    title: `Import ${id}`,
    batch: batch.rows[0],
    rows: rows.rows,
  });
}));

module.exports = router;
