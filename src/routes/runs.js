const express = require('express');
const { query, withTransaction } = require('../db');
const { asyncRoute, renderPage, intOrNull, isIsoDate, pageWindow } = require('../http');
const { requireCan, requireAny, deny, guard } = require('../auth/gate');
const { can, scopeBinds, atmScopeSql, locationScopeSql, runScopeSql } = require('../auth/permissions');
const { recordChange } = require('../auth/activity');
const { loadReference } = require('../services/reference');
const { loadSuggestion } = require('../services/denom');
const { saveRun, runTargetsOutOfScope } = require('../services/runs');
const { totalLoaded } = require('../../public/js/money');

const router = express.Router();
const STATUSES = ['planned', 'in_progress', 'completed', 'cancelled'];
const PAGE_SIZE = 20;

function blankLine() {
  return { atmCode: '', cassette: 4, denomination: 2000, noteCount: '', amount: 0 };
}

router.get('/runs', asyncRoute(async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const plannedDate = isIsoDate(req.query.date || '') ? req.query.date : '';
  const locationId = intOrNull(req.query.location_id);
  const filters = [status || null, plannedDate || null, locationId, ...scopeBinds(req.user)];
  const where = `
    WHERE ($1::text IS NULL OR rr.status = $1)
      AND ($2::date IS NULL OR rr.planned_date = $2)
      AND ($3::int IS NULL OR rr.location_id = $3)
      AND ${runScopeSql('rr', 4)}`;
  const [count, locations, dates, plans] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total FROM replenishment_runs rr ${where}`, filters),
    query(
      `SELECT l.location_id, l.location_name
       FROM locations l
       WHERE ${locationScopeSql('l', 1)}
       ORDER BY l.location_name`,
      scopeBinds(req.user)
    ),
    query(`SELECT CURRENT_DATE::text AS today, (CURRENT_DATE + 1)::text AS tomorrow`),
    query(`SELECT plan_id, target_date::text AS target_date, runs_created, atms_assigned, planned_at,
                  location_id
           FROM replenishment_plan_log
           ORDER BY plan_id DESC
           LIMIT 6`),
  ]);
  const total = count.rows[0].total;
  const window = pageWindow(req.query.page, PAGE_SIZE, total);
  const rows = await query(
    `SELECT rr.run_id, rr.planned_date::text AS planned_date, rr.status, rr.created_by,
            l.location_name, cv.van_code, cu.full_name AS custodian_name,
            COUNT(DISTINCT cl.atm_id)::int AS stops,
            COALESCE(SUM(cl.amount), 0) AS total_loaded
     FROM replenishment_runs rr
     JOIN locations l ON l.location_id = rr.location_id
     JOIN cash_vans cv ON cv.van_id = rr.van_id
     JOIN custodians cu ON cu.custodian_id = rr.custodian_id
     LEFT JOIN cassette_loads cl ON cl.run_id = rr.run_id
     ${where}
     GROUP BY rr.run_id, l.location_id, l.location_name, cv.van_id, cv.van_code, cu.custodian_id, cu.full_name
     ORDER BY rr.planned_date DESC, rr.run_id DESC
     LIMIT $8 OFFSET $9`,
    [...filters, window.pageSize, window.offset]
  );
  renderPage(req, res, 'runs', {
    title: 'Replenishment Runs',
    rows: rows.rows,
    locations: locations.rows,
    plans: plans.rows,
    tomorrow: dates.rows[0].tomorrow,
    total,
    page: window.page,
    pages: window.pages,
    filters: { status, date: plannedDate, location_id: locationId || '' },
  });
}));

router.post('/runs/plan', requireCan('planRuns'), asyncRoute(async (req, res) => {
  const plannedDate = req.body.planned_date;
  const rawLocation = req.body.location_id;
  const locationId = intOrNull(rawLocation);
  if (!isIsoDate(plannedDate)) {
    return res.redirect('/runs?warning=Choose a valid date before planning routes.');
  }
  const locationText = rawLocation == null ? '' : String(rawLocation).trim();
  if (locationText && !locationId) {
    return res.redirect('/runs?warning=Choose a valid location.');
  }
  const scope = scopeBinds(req.user);
  if (locationId) {
    const location = await query('SELECT 1 FROM locations WHERE location_id = $1', [locationId]);
    if (!location.rowCount) return res.redirect('/runs?warning=Choose a valid location.');
    const allowed = await query(
      `SELECT 1 FROM locations l WHERE l.location_id = $1 AND ${locationScopeSql('l', 2)}`,
      [locationId, ...scope]
    );
    if (!allowed.rowCount) return deny(req, res);
  }
  try {
    await query(
      'CALL plan_replenishment_routes($1::date, $2::int, 0, 0, $3::int, $4::text)',
      [plannedDate, locationId, scope[1], scope[0]]
    );
  } catch (err) {
    console.error(err);
    return res.redirect('/runs?warning=The planner could not finish.');
  }
  const log = await query(
    `SELECT runs_created, atms_assigned
     FROM replenishment_plan_log
     WHERE target_date = $1::date
     ORDER BY plan_id DESC
     LIMIT 1`,
    [plannedDate]
  );
  const row = log.rows[0] || { runs_created: 0, atms_assigned: 0 };
  await recordChange(req, {
    action: 'create',
    entity: 'replenishment plan',
    entityId: plannedDate,
    before: null,
    after: { date: plannedDate, runs: row.runs_created, atms: row.atms_assigned, location_id: locationId },
  });
  const notice = row.atms_assigned
    ? `Planned ${row.runs_created} run${row.runs_created === 1 ? '' : 's'} covering ${row.atms_assigned} ATMs for ${plannedDate}.`
    : `No new stops for ${plannedDate}. Forecast cash does not exceed remaining cash, or those ATMs are already on a run.`;
  const params = new URLSearchParams({ notice, date: plannedDate });
  res.redirect(`/runs?${params.toString()}`);
}));

router.get('/runs/new', requireCan('createRun'), asyncRoute(async (req, res) => {
  const [ref, dates] = await Promise.all([
    loadReference(req.user),
    query(`SELECT (CURRENT_DATE + 1)::text AS tomorrow`),
  ]);
  const atmId = intOrNull(req.query.atm_id);
  if (atmId) {
    const allowed = await query(
      `SELECT 1 FROM atms a WHERE a.atm_id = $1 AND a.atm_id IN (${atmScopeSql(2)})`,
      [atmId, ...scopeBinds(req.user)]
    );
    if (!allowed.rowCount) {
      const exists = await query('SELECT 1 FROM atms WHERE atm_id = $1', [atmId]);
      if (exists.rowCount) return deny(req, res);
    }
  }
  const suggestion = atmId ? await loadSuggestion({ query }, atmId) : null;
  const lines = suggestion && suggestion.notes.some((row) => row.notes > 0)
    ? suggestion.notes.filter((row) => row.notes > 0).map((row, index) => ({
      atmCode: suggestion.atmCode,
      cassette: index + 1,
      denomination: row.denomination,
      noteCount: row.notes,
      amount: row.amount,
    }))
    : [blankLine()];
  renderPage(req, res, 'run-form', {
    title: 'New Replenishment Run',
    action: '/runs',
    run: null,
    form: {
      planned_date: dates.rows[0].tomorrow,
      status: 'planned',
      location_id: '',
      van_id: '',
      custodian_id: '',
      notes: '',
    },
    lines,
    suggestion,
    total: lines.reduce((sum, line) => sum + Number(line.amount || 0), 0),
    errors: [],
    ref,
  });
}));

function needsApproval(user, status, approvalStatus) {
  if (status !== 'in_progress' && status !== 'completed') return false;
  if (can(user, 'approveRuns')) return false;
  return approvalStatus !== 'approved';
}

router.post('/runs', requireCan('createRun'), asyncRoute(async (req, res) => {
  const scope = scopeBinds(req.user);
  if (await runTargetsOutOfScope({ query }, req.body, scope)) return deny(req, res);
  if (needsApproval(req.user, req.body.status, null)) {
    return res.redirect('/runs/new?warning=This run has to be approved before it can be dispatched or completed.');
  }
  const saved = await withTransaction((client) => saveRun(client, req.body, null, scope));
  if (saved.denied) return deny(req, res);
  if (saved.errors) {
    const ref = await loadReference(req.user);
    return renderPage(req, res, 'run-form', {
      title: 'New Replenishment Run',
      action: '/runs',
      run: null,
      form: saved.form,
      lines: saved.lines.length ? saved.lines : [blankLine()],
      total: saved.total,
      errors: saved.errors,
      ref,
      statusCode: 400,
    });
  }
  if (!can(req.user, 'approveRuns')) {
    await query(`UPDATE replenishment_runs SET approval_status = 'pending' WHERE run_id = $1`, [saved.runId]);
  }
  await recordChange(req, {
    action: 'create',
    entity: 'replenishment run',
    entityId: saved.runId,
    before: null,
    after: { status: req.body.status || 'planned', total: saved.total },
  });
  res.redirect(`/runs/${saved.runId}?notice=${encodeURIComponent('Run saved. Total loaded ' + saved.total + '.')}`);
}));

router.get('/runs/:id', asyncRoute(async (req, res, next) => {
  if (req.params.id === 'new') return next();
  const id = intOrNull(req.params.id);
  if (!id) return renderPage(req, res, 'not-found', { title: 'Run Not Found', statusCode: 404 });
  const visible = await query(
    `SELECT 1 FROM replenishment_runs rr WHERE rr.run_id = $1 AND ${runScopeSql('rr', 2)}`,
    [id, ...scopeBinds(req.user)]
  );
  const [run, loads, ref] = await Promise.all([
    query(
      `SELECT run_id, van_id, custodian_id, location_id, planned_date::text AS planned_date,
              status, notes, created_by, approval_status
       FROM replenishment_runs WHERE run_id = $1`,
      [id]
    ),
    query(
      `SELECT cl.cassette_number, cl.denomination, cl.note_count, cl.amount, a.atm_code
       FROM cassette_loads cl
       JOIN atms a ON a.atm_id = cl.atm_id
       WHERE cl.run_id = $1
       ORDER BY a.atm_code, cl.cassette_number`,
      [id]
    ),
    loadReference(req.user),
  ]);
  if (!run.rowCount) return renderPage(req, res, 'not-found', { title: 'Run Not Found', statusCode: 404 });
  if (!visible.rowCount) return deny(req, res);
  const lines = loads.rows.map((row) => ({
    atmCode: row.atm_code,
    cassette: row.cassette_number,
    denomination: Number(row.denomination),
    noteCount: row.note_count,
    amount: Number(row.amount),
  }));
  const header = run.rows[0];
  renderPage(req, res, 'run-form', {
    title: `Replenishment Run ${header.run_id}`,
    action: `/runs/${header.run_id}`,
    run: header,
    form: {
      planned_date: header.planned_date,
      status: header.status,
      location_id: header.location_id,
      van_id: header.van_id,
      custodian_id: header.custodian_id,
      notes: header.notes || '',
    },
    lines: lines.length ? lines : [blankLine()],
    total: totalLoaded(lines),
    errors: [],
    ref,
  });
}));

router.post('/runs/:id', requireAny('editRun', 'editOwnRun'), asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return renderPage(req, res, 'not-found', { title: 'Run Not Found', statusCode: 404 });
  const existing = await query(
    `SELECT rr.status, rr.approval_status, rr.planned_date::text AS planned_date, rr.van_id, rr.custodian_id,
            rr.location_id, rr.notes
     FROM replenishment_runs rr
     WHERE rr.run_id = $1 AND ${runScopeSql('rr', 2)}`,
    [id, ...scopeBinds(req.user)]
  );
  if (!existing.rowCount) return deny(req, res);
  const scope = scopeBinds(req.user);
  if (await runTargetsOutOfScope({ query }, req.body, scope, id)) return deny(req, res);
  if (needsApproval(req.user, req.body.status, existing.rows[0].approval_status)) {
    return res.redirect(`/runs/${id}?warning=This run has to be approved before it can be dispatched or completed.`);
  }
  const saved = await withTransaction((client) => saveRun(client, req.body, id, scope));
  if (saved.denied) return deny(req, res);
  if (saved.errors) {
    const ref = await loadReference(req.user);
    return renderPage(req, res, 'run-form', {
      title: `Replenishment Run ${id}`,
      action: `/runs/${id}`,
      run: { run_id: id, created_by: '' },
      form: saved.form,
      lines: saved.lines.length ? saved.lines : [blankLine()],
      total: saved.total,
      errors: saved.errors,
      ref,
      statusCode: 400,
    });
  }
  const after = await query(
    `SELECT status, planned_date::text AS planned_date, van_id, custodian_id, location_id, notes
     FROM replenishment_runs WHERE run_id = $1`,
    [id]
  );
  await recordChange(req, {
    action: 'update',
    entity: 'replenishment run',
    entityId: id,
    before: existing.rows[0],
    after: { ...after.rows[0], total: saved.total },
  });
  res.redirect(`/runs/${id}?notice=${encodeURIComponent('Run updated. Total loaded ' + saved.total + '.')}`);
}));

router.post('/runs/:id/approve', requireCan('approveRuns'), asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return res.redirect('/runs?warning=That run was not found.');
  const existing = await query(
    `SELECT approval_status FROM replenishment_runs rr WHERE rr.run_id = $1 AND ${runScopeSql('rr', 2)}`,
    [id, ...scopeBinds(req.user)]
  );
  if (!existing.rowCount) return deny(req, res);
  await query(
    `UPDATE replenishment_runs
     SET approval_status = 'approved', approved_at = CURRENT_TIMESTAMP, approved_by = $2
     WHERE run_id = $1`,
    [id, req.user.user_id]
  );
  await recordChange(req, {
    action: 'approve',
    entity: 'replenishment run',
    entityId: id,
    before: { approval_status: existing.rows[0].approval_status },
    after: { approval_status: 'approved' },
  });
  res.redirect(`/runs/${id}?notice=Run approved.`);
}));

router.post('/runs/:id/delete', requireCan('deleteRun'), asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return res.redirect('/runs?warning=That run was not found.');
  const existing = await query('SELECT run_id FROM replenishment_runs WHERE run_id = $1', [id]);
  if (!existing.rowCount) return res.redirect('/runs?warning=That run was not found.');
  const visible = await query(
    `SELECT 1 FROM replenishment_runs rr WHERE rr.run_id = $1 AND ${runScopeSql('rr', 2)}`,
    [id, ...scopeBinds(req.user)]
  );
  if (!visible.rowCount) return deny(req, res);
  const deleted = await query(
    `DELETE FROM replenishment_runs rr WHERE rr.run_id = $1 AND ${runScopeSql('rr', 2)}`,
    [id, ...scopeBinds(req.user)]
  );
  if (!deleted.rowCount) return deny(req, res);
  await recordChange(req, {
    action: 'delete',
    entity: 'replenishment run',
    entityId: id,
    before: { run_id: id },
    after: null,
  });
  res.redirect('/runs?notice=Replenishment run deleted.');
}));

module.exports = guard(router, 'runs');
