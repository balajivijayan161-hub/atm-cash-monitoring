const express = require('express');
const multer = require('multer');
const { query, withTransaction } = require('../db');
const { asyncRoute, renderPage, intOrNull, batchName } = require('../http');
const { importSwitchContent } = require('../services/switchImport');
const { csrfOk, guard } = require('../auth/gate');
const { recordChange } = require('../auth/activity');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

async function recentBatches() {
  const rows = await query(
    `SELECT batch_id, filename, source, file_format, uploaded_at, row_count, loaded_count, error_count, status
     FROM switch_import_batches
     ORDER BY batch_id DESC
     LIMIT 12`
  );
  return rows.rows;
}

router.get('/switch', asyncRoute(async (req, res) => {
  renderPage(req, res, 'switch', {
    title: 'Bank Data Import',
    batches: await recentBatches(),
    errors: [],
    pasted: '',
  });
}));

router.post('/switch', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      req.fileError = 'The file could not be read. The limit is 5 MB.';
    }
    if (!csrfOk(req)) {
      res.locals.accessDenied = true;
      return res.status(403).type('html').send('<!DOCTYPE html><html><body><main class="content"><h1>The form expired.</h1><p>Go back, refresh the page, and submit it again.</p></main></body></html>');
    }
    next();
  });
}, asyncRoute(async (req, res) => {
  if (req.fileError) {
    return renderPage(req, res, 'switch', {
      title: 'Bank Data Import',
      batches: await recentBatches(),
      errors: [req.fileError],
      pasted: '',
      statusCode: 400,
    });
  }
  const pasted = typeof req.body.pasted === 'string' ? req.body.pasted : '';
  const fileText = req.file ? req.file.buffer.toString('utf8') : '';
  const content = fileText.trim() ? fileText : pasted;
  const filename = req.file && fileText.trim() ? req.file.originalname : 'pasted.txt';
  if (!content.trim()) {
    return renderPage(req, res, 'switch', {
      title: 'Bank Data Import',
      batches: await recentBatches(),
      errors: ['Choose a file or paste switch rows first.'],
      pasted,
      statusCode: 400,
    });
  }
  try {
    const result = await withTransaction((client) => importSwitchContent(client, {
      filename,
      content,
      replaceExisting: req.body.replace === 'on',
    }));
    if (!result.ok) {
      return renderPage(req, res, 'switch', {
        title: 'Bank Data Import',
        batches: await recentBatches(),
        errors: [result.fileError],
        pasted,
        statusCode: 400,
      });
    }
    await recordChange(req, {
      action: 'create',
      entity: 'bank import',
      entityId: result.batchId,
      before: null,
      after: { accepted: result.loaded, rejected: result.errors, rows: result.rowCount },
    });
    const notice = result.loaded
      ? `Accepted ${result.loaded} of ${result.rowCount} rows. ${result.errors} rejected.`
      : `Nothing was accepted. ${result.errors} of ${result.rowCount} rows were rejected.`;
    return res.redirect(`/switch/${result.batchId}?notice=${encodeURIComponent(notice)}`);
  } catch (err) {
    console.error(err);
    return renderPage(req, res, 'switch', {
      title: 'Bank Data Import',
      batches: await recentBatches(),
      errors: ['That import could not be saved. Check the rows and try again.'],
      pasted,
      statusCode: 400,
    });
  }
}));

router.get('/switch/:id', asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return renderPage(req, res, 'not-found', { title: 'Import Not Found', statusCode: 404 });
  const [batch, rows] = await Promise.all([
    query('SELECT * FROM switch_import_batches WHERE batch_id = $1', [id]),
    query(
      `SELECT line_no, raw_line, atm_code, txn_date::text AS txn_date, amount, txn_count, status, error_message
       FROM switch_import_rows
       WHERE batch_id = $1
       ORDER BY line_no`,
      [id]
    ),
  ]);
  if (!batch.rowCount) return renderPage(req, res, 'not-found', { title: 'Import Not Found', statusCode: 404 });
  renderPage(req, res, 'switch-batch', {
    title: batchName(batch.rows[0]),
    batch: batch.rows[0],
    rows: rows.rows,
  });
}));

module.exports = guard(router, 'importData');
