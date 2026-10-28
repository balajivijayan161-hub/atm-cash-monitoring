const express = require('express');
const { query, withTransaction } = require('../db');
const { asyncRoute, renderPage, intOrNull, isIsoDate, inr, parseLedgerAmount, ledgerAmountError } = require('../http');
const { requireCan, deny, guard } = require('../auth/gate');
const { can, scopeBinds, atmScopeSql, runScopeSql } = require('../auth/permissions');
const { recordChange } = require('../auth/activity');
const { REASONS, caseChangeError } = require('../services/reconCase');

const router = express.Router();

function formLists(user) {
  const scope = scopeBinds(user);
  return Promise.all([
    query(`SELECT a.atm_id, a.atm_code, a.site_name, l.location_name
           FROM atms a
           JOIN branches b ON b.branch_id = a.branch_id
           JOIN locations l ON l.location_id = b.location_id
           WHERE a.atm_id IN (${atmScopeSql(1)})
           ORDER BY l.location_name, a.atm_code`, scope),
    query(`SELECT rr.run_id, rr.planned_date::text AS planned_date, cv.van_code, l.location_name
           FROM replenishment_runs rr
           JOIN cash_vans cv ON cv.van_id = rr.van_id
           JOIN locations l ON l.location_id = rr.location_id
           WHERE ${runScopeSql('rr', 1)}
           ORDER BY rr.planned_date DESC, rr.run_id DESC
           LIMIT 40`, scope),
  ]);
}

async function reconInScope(id, user) {
  return query(
    `SELECT r.case_status, r.reason_code
     FROM reconciliations r
     JOIN atms a ON a.atm_id = r.atm_id
     WHERE r.reconciliation_id = $1
       AND a.atm_id IN (${atmScopeSql(2)})`,
    [id, ...scopeBinds(user)]
  );
}

router.get('/reconciliations', asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT r.reconciliation_id, r.recon_date::text AS recon_date, r.expected_amount, r.counted_amount,
            r.difference, r.notes, r.created_at, r.case_status, a.atm_id, a.atm_code, a.site_name,
            ft.ticket_id, ft.ticket_no, ft.status AS ticket_status
     FROM reconciliations r
     JOIN atms a ON a.atm_id = r.atm_id
     LEFT JOIN fault_tickets ft ON ft.reconciliation_id = r.reconciliation_id
     WHERE a.atm_id IN (${atmScopeSql(1)})
     ORDER BY r.created_at DESC
     LIMIT 40`,
    scopeBinds(req.user)
  );
  renderPage(req, res, 'reconciliations', { title: 'Reconciliations', rows: rows.rows });
}));

router.get('/reconciliations/new', asyncRoute(async (req, res) => {
  const preset = intOrNull(req.query.atm_id);
  if (preset) {
    const exists = await query('SELECT 1 FROM atms WHERE atm_id = $1', [preset]);
    if (exists.rowCount) {
      const allowed = await query(
        `SELECT 1 FROM atms a WHERE a.atm_id = $1 AND a.atm_id IN (${atmScopeSql(2)})`,
        [preset, ...scopeBinds(req.user)]
      );
      if (!allowed.rowCount) return deny(req, res);
    }
  }
  const [[atms, runs], dates] = await Promise.all([
    formLists(req.user),
    query('SELECT CURRENT_DATE::text AS today'),
  ]);
  renderPage(req, res, 'recon-form', {
    title: 'New Reconciliation',
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

router.post('/reconciliations', requireCan('createRecon'), asyncRoute(async (req, res) => {
  const atmId = intOrNull(req.body.atm_id);
  const runText = req.body.run_id == null ? '' : String(req.body.run_id).trim();
  const runId = intOrNull(req.body.run_id);
  const scope = scopeBinds(req.user);
  if (atmId) {
    const atm = await query('SELECT 1 FROM atms WHERE atm_id = $1', [atmId]);
    if (atm.rowCount) {
      const allowed = await query(
        `SELECT 1 FROM atms a WHERE a.atm_id = $1 AND a.atm_id IN (${atmScopeSql(2)})`,
        [atmId, ...scope]
      );
      if (!allowed.rowCount) return deny(req, res);
    }
  }
  if (runId) {
    const run = await query('SELECT 1 FROM replenishment_runs WHERE run_id = $1', [runId]);
    if (run.rowCount) {
      const allowed = await query(
        `SELECT 1 FROM replenishment_runs rr WHERE rr.run_id = $1 AND ${runScopeSql('rr', 2)}`,
        [runId, ...scope]
      );
      if (!allowed.rowCount) return deny(req, res);
    }
  }
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
    const [atms, runs] = await formLists(req.user);
    return renderPage(req, res, 'recon-form', {
      title: 'New Reconciliation',
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
    return {
      reconciliationId: inserted.rows[0].reconciliation_id,
      difference: inserted.rows[0].difference,
      ticket: ticket.rows[0] || null,
    };
  });

  await recordChange(req, {
    action: 'create',
    entity: 'reconciliation',
    entityId: saved.reconciliationId,
    before: null,
    after: { atm_id: atmId, difference: saved.difference },
  });
  if (saved.ticket) {
    const notice = `Counted cash did not match. ${saved.ticket.ticket_no} was raised automatically for a difference of ${inr(saved.difference)}.`;
    return res.redirect(`/tickets?notice=${encodeURIComponent(notice)}`);
  }
  return res.redirect('/reconciliations?notice=Reconciliation saved. The count matched, so no fault ticket was raised.');
}));

router.get('/reconciliations/:id', asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return renderPage(req, res, 'not-found', { title: 'Case Not Found', statusCode: 404 });
  const row = await query(
    `SELECT r.*, r.recon_date::text AS recon_date, a.atm_code, a.site_name, u.full_name AS assignee_name
     FROM reconciliations r
     JOIN atms a ON a.atm_id = r.atm_id
     LEFT JOIN users u ON u.user_id = r.assignee_id
     WHERE r.reconciliation_id = $1`,
    [id]
  );
  if (!row.rowCount || !row.rows[0].case_status) {
    return renderPage(req, res, 'not-found', { title: 'Case Not Found', statusCode: 404 });
  }
  const allowed = await reconInScope(id, req.user);
  if (!allowed.rowCount) return deny(req, res);
  const comments = await query(
    `SELECT c.body, c.created_at, u.full_name
     FROM recon_comments c
     LEFT JOIN users u ON u.user_id = c.user_id
     WHERE c.reconciliation_id = $1
     ORDER BY c.created_at`,
    [id]
  );
  const people = await query(`SELECT user_id, full_name, role FROM users WHERE active ORDER BY full_name`);
  renderPage(req, res, 'recon-case', {
    title: 'Variance Case',
    item: row.rows[0],
    comments: comments.rows,
    people: people.rows,
    reasons: REASONS,
    canApprove: can(req.user, 'approveRecons'),
  });
}));

router.post('/reconciliations/:id/comment', asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!id || !body) return res.redirect(`/reconciliations/${id || ''}?warning=Enter a note.`);
  const found = await query(`SELECT case_status FROM reconciliations WHERE reconciliation_id = $1`, [id]);
  if (!found.rowCount) return renderPage(req, res, 'not-found', { title: 'Case Not Found', statusCode: 404 });
  const allowed = await reconInScope(id, req.user);
  if (!allowed.rowCount) return deny(req, res);
  await query(
    `INSERT INTO recon_comments (reconciliation_id, user_id, body) VALUES ($1, $2, $3)`,
    [id, req.user.user_id, body]
  );
  await recordChange(req, {
    action: 'create',
    entity: 'variance note',
    entityId: id,
    before: null,
    after: { note: body },
  });
  res.redirect(`/reconciliations/${id}?notice=Note added.`);
}));

router.post('/reconciliations/:id/status', asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return renderPage(req, res, 'not-found', { title: 'Case Not Found', statusCode: 404 });
  const found = await query(`SELECT case_status, reason_code FROM reconciliations WHERE reconciliation_id = $1`, [id]);
  if (!found.rowCount || !found.rows[0].case_status) {
    return renderPage(req, res, 'not-found', { title: 'Case Not Found', statusCode: 404 });
  }
  const allowedCase = await reconInScope(id, req.user);
  if (!allowedCase.rowCount) return deny(req, res);
  const to = String(req.body.case_status || '');
  const reason = String(req.body.reason_code || found.rows[0].reason_code || '');
  const assignee = intOrNull(req.body.assignee_id);
  const error = caseChangeError({
    from: found.rows[0].case_status,
    to,
    canApprove: can(req.user, 'approveRecons'),
    reason,
  });
  if (error) return res.redirect(`/reconciliations/${id}?warning=${encodeURIComponent(error)}`);
  const closing = to === 'resolved' || to === 'written_off';
  await query(
    `UPDATE reconciliations
     SET case_status = $2::varchar,
         reason_code = CASE WHEN $3::boolean THEN NULLIF($4, '')::varchar ELSE reason_code END,
         assignee_id = COALESCE($5::int, assignee_id),
         closed_by = CASE WHEN $3::boolean THEN $6::int ELSE closed_by END,
         closed_at = CASE WHEN $3::boolean THEN CURRENT_TIMESTAMP ELSE closed_at END
     WHERE reconciliation_id = $1`,
    [id, to, closing, reason || '', assignee, req.user.user_id]
  );
  await recordChange(req, {
    action: closing ? 'approve' : 'update',
    entity: 'variance case',
    entityId: id,
    before: { case_status: found.rows[0].case_status },
    after: { case_status: to, reason_code: reason || null },
  });
  res.redirect(`/reconciliations/${id}?notice=Case updated.`);
}));

module.exports = guard(router, 'recons');
