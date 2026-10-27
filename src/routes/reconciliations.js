const express = require('express');
const { query, withTransaction } = require('../db');
const { asyncRoute, renderPage, intOrNull, isIsoDate, inr, parseLedgerAmount, ledgerAmountError } = require('../http');

const router = express.Router();

router.get('/reconciliations', asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT r.reconciliation_id, r.recon_date::text AS recon_date, r.expected_amount, r.counted_amount,
            r.difference, r.notes, r.created_at, a.atm_id, a.atm_code, a.site_name,
            ft.ticket_id, ft.ticket_no, ft.status AS ticket_status
     FROM reconciliations r
     JOIN atms a ON a.atm_id = r.atm_id
     LEFT JOIN fault_tickets ft ON ft.reconciliation_id = r.reconciliation_id
     ORDER BY r.created_at DESC
     LIMIT 40`
  );
  renderPage(req, res, 'reconciliations', { title: 'Reconciliations', rows: rows.rows });
}));

router.get('/reconciliations/new', asyncRoute(async (req, res) => {
  const [atms, runs, dates] = await Promise.all([
    query(`SELECT a.atm_id, a.atm_code, a.site_name, l.location_name
           FROM atms a
           JOIN branches b ON b.branch_id = a.branch_id
           JOIN locations l ON l.location_id = b.location_id
           ORDER BY l.location_name, a.atm_code`),
    query(`SELECT rr.run_id, rr.planned_date::text AS planned_date, cv.van_code, l.location_name
           FROM replenishment_runs rr
           JOIN cash_vans cv ON cv.van_id = rr.van_id
           JOIN locations l ON l.location_id = rr.location_id
           ORDER BY rr.planned_date DESC, rr.run_id DESC
           LIMIT 40`),
    query('SELECT CURRENT_DATE::text AS today'),
  ]);
  renderPage(req, res, 'recon-form', {
    title: 'New reconciliation',
    atms: atms.rows,
    runs: runs.rows,
    form: {
      atm_id: intOrNull(req.query.atm_id) || '',
      run_id: '',
      recon_date: dates.rows[0].today,
      expected_amount: '',
      counted_amount: '',
      notes: '',
    },
    errors: [],
  });
}));

router.post('/reconciliations', asyncRoute(async (req, res) => {
  const atmId = intOrNull(req.body.atm_id);
  const runText = req.body.run_id == null ? '' : String(req.body.run_id).trim();
  const runId = intOrNull(req.body.run_id);
  const reconDate = typeof req.body.recon_date === 'string' ? req.body.recon_date : '';
  const expected = parseLedgerAmount(req.body.expected_amount || '');
  const counted = parseLedgerAmount(req.body.counted_amount || '');
  const notes = String(req.body.notes || '').trim().slice(0, 2000);
  const errors = [];
  if (!atmId) errors.push('Choose an ATM.');
  if (!isIsoDate(reconDate)) errors.push('Choose a valid reconciliation date.');
  else {
    const today = await query('SELECT CURRENT_DATE::text AS today');
    if (reconDate > today.rows[0].today) errors.push('Reconciliation date is in the future.');
  }
  const expectedError = ledgerAmountError(req.body.expected_amount || '', 'Expected amount');
  const countedError = ledgerAmountError(req.body.counted_amount || '', 'Counted amount');
  if (expectedError) errors.push(expectedError);
  if (countedError) errors.push(countedError);
  if (runText && !runId) errors.push('That replenishment run does not exist.');
  else if (runId) {
    const run = await query('SELECT run_id FROM replenishment_runs WHERE run_id = $1', [runId]);
    if (!run.rowCount) errors.push('That replenishment run does not exist.');
  }
  if (atmId) {
    const atm = await query('SELECT atm_id FROM atms WHERE atm_id = $1', [atmId]);
    if (!atm.rowCount) errors.push('That ATM does not exist.');
  }
  const form = {
    atm_id: atmId || '',
    run_id: runId || '',
    recon_date: reconDate,
    expected_amount: req.body.expected_amount || '',
    counted_amount: req.body.counted_amount || '',
    notes,
  };
  if (errors.length) {
    const [atms, runs] = await Promise.all([
      query(`SELECT a.atm_id, a.atm_code, a.site_name, l.location_name
             FROM atms a
             JOIN branches b ON b.branch_id = a.branch_id
             JOIN locations l ON l.location_id = b.location_id
             ORDER BY l.location_name, a.atm_code`),
      query(`SELECT rr.run_id, rr.planned_date::text AS planned_date, cv.van_code, l.location_name
             FROM replenishment_runs rr
             JOIN cash_vans cv ON cv.van_id = rr.van_id
             JOIN locations l ON l.location_id = rr.location_id
             ORDER BY rr.planned_date DESC
             LIMIT 40`),
    ]);
    return renderPage(req, res, 'recon-form', {
      title: 'New reconciliation',
      atms: atms.rows,
      runs: runs.rows,
      form,
      errors,
      statusCode: 400,
    });
  }

  const saved = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO reconciliations (atm_id, run_id, recon_date, expected_amount, counted_amount, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING reconciliation_id, difference`,
      [atmId, runId, reconDate, expected, counted, notes || null]
    );
    const ticket = await client.query(
      `SELECT ticket_id, ticket_no FROM fault_tickets WHERE reconciliation_id = $1`,
      [inserted.rows[0].reconciliation_id]
    );
    return { difference: inserted.rows[0].difference, ticket: ticket.rows[0] || null };
  });

  if (saved.ticket) {
    const notice = `Counted cash did not match. ${saved.ticket.ticket_no} was raised automatically for a difference of ${inr(saved.difference)}.`;
    return res.redirect(`/tickets?notice=${encodeURIComponent(notice)}`);
  }
  return res.redirect('/reconciliations?notice=Reconciliation saved. The count matched, so no fault ticket was raised.');
}));

module.exports = router;
