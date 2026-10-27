const express = require('express');
const { query, withTransaction } = require('../db');
const { asyncRoute, renderPage, intOrNull, isIsoDate } = require('../http');
const { loadReference } = require('../services/reference');
const { saveRun } = require('../services/runs');
const { totalLoaded } = require('../../public/js/money');

const router = express.Router();
const STATUSES = ['planned', 'in_progress', 'completed', 'cancelled'];
const PAGE_SIZE = 20;

function blankLine() {
  return { atmCode: '', cassette: 4, denomination: 2000, noteCount: '', amount: 0 };
}

router.get('/runs', asyncRoute(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const plannedDate = isIsoDate(req.query.date || '') ? req.query.date : '';
  const locationId = intOrNull(req.query.location_id);
  const filters = [status || null, plannedDate || null, locationId];
  const where = `
    WHERE ($1::text IS NULL OR rr.status = $1)
      AND ($2::date IS NULL OR rr.planned_date = $2)
      AND ($3::int IS NULL OR rr.location_id = $3)`;
  const [rows, count, locations, dates, plans] = await Promise.all([
    query(
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
       LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      filters
    ),
    query(`SELECT COUNT(*)::int AS total FROM replenishment_runs rr ${where}`, filters),
    query('SELECT location_id, location_name FROM locations ORDER BY location_name'),
    query(`SELECT CURRENT_DATE::text AS today, (CURRENT_DATE + 1)::text AS tomorrow`),
    query(`SELECT plan_id, target_date::text AS target_date, runs_created, atms_assigned, planned_at,
                  location_id
           FROM replenishment_plan_log
           ORDER BY plan_id DESC
           LIMIT 6`),
  ]);
  const total = count.rows[0].total;
  renderPage(req, res, 'runs', {
    title: 'Replenishment runs',
    rows: rows.rows,
    locations: locations.rows,
    plans: plans.rows,
    tomorrow: dates.rows[0].tomorrow,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    filters: { status, date: plannedDate, location_id: locationId || '' },
  });
}));

router.post('/runs/plan', asyncRoute(async (req, res) => {
  const plannedDate = req.body.planned_date;
  const locationId = intOrNull(req.body.location_id);
  if (!isIsoDate(plannedDate)) {
    return res.redirect('/runs?warning=Choose a valid date before planning routes.');
  }
  try {
    await query('CALL plan_replenishment_routes($1::date, $2::int, 0, 0)', [plannedDate, locationId]);
  } catch (err) {
    console.error(err);
    return res.redirect(`/runs?warning=${encodeURIComponent('The planner could not finish. ' + err.message)}`);
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
  const notice = row.atms_assigned
    ? `Planned ${row.runs_created} run${row.runs_created === 1 ? '' : 's'} covering ${row.atms_assigned} ATMs for ${plannedDate}.`
    : `No new stops for ${plannedDate}. Forecast cash does not exceed remaining cash, or those ATMs are already on a run.`;
  const params = new URLSearchParams({ notice, date: plannedDate });
  res.redirect(`/runs?${params.toString()}`);
}));

router.get('/runs/new', asyncRoute(async (req, res) => {
  const [ref, dates] = await Promise.all([
    loadReference(),
    query(`SELECT (CURRENT_DATE + 1)::text AS tomorrow`),
  ]);
  renderPage(req, res, 'run-form', {
    title: 'New replenishment run',
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
    lines: [blankLine()],
    total: 0,
    errors: [],
    ref,
  });
}));

router.post('/runs', asyncRoute(async (req, res) => {
  const saved = await withTransaction((client) => saveRun(client, req.body, null));
  if (saved.errors) {
    const ref = await loadReference();
    return renderPage(req, res, 'run-form', {
      title: 'New replenishment run',
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
  res.redirect(`/runs/${saved.runId}?notice=${encodeURIComponent('Run saved. Total loaded ' + saved.total + '.')}`);
}));

router.get('/runs/:id', asyncRoute(async (req, res, next) => {
  if (req.params.id === 'new') return next();
  const id = intOrNull(req.params.id);
  if (!id) return renderPage(req, res, 'not-found', { title: 'Run not found', statusCode: 404 });
  const [run, loads, ref] = await Promise.all([
    query(
      `SELECT run_id, van_id, custodian_id, location_id, planned_date::text AS planned_date,
              status, notes, created_by
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
    loadReference(),
  ]);
  if (!run.rowCount) return renderPage(req, res, 'not-found', { title: 'Run not found', statusCode: 404 });
  const lines = loads.rows.map((row) => ({
    atmCode: row.atm_code,
    cassette: row.cassette_number,
    denomination: Number(row.denomination),
    noteCount: row.note_count,
    amount: Number(row.amount),
  }));
  const header = run.rows[0];
  renderPage(req, res, 'run-form', {
    title: `Run ${header.run_id}`,
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

router.post('/runs/:id', asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return renderPage(req, res, 'not-found', { title: 'Run not found', statusCode: 404 });
  const saved = await withTransaction((client) => saveRun(client, req.body, id));
  if (saved.errors) {
    const ref = await loadReference();
    return renderPage(req, res, 'run-form', {
      title: `Run ${id}`,
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
  res.redirect(`/runs/${id}?notice=${encodeURIComponent('Run updated. Total loaded ' + saved.total + '.')}`);
}));

router.post('/runs/:id/delete', asyncRoute(async (req, res) => {
  const id = intOrNull(req.params.id);
  if (!id) return res.redirect('/runs?warning=That run was not found.');
  await query('DELETE FROM replenishment_runs WHERE run_id = $1', [id]);
  res.redirect('/runs?notice=Replenishment run deleted.');
}));

module.exports = router;
