const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { neutralizeCsv } = require('../src/routes/activity');
const { ensureUsers, withRollback, pool, createAgent } = require('./helpers');

let server;
let base;

before(async () => {
  await ensureUsers();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function signed(username) {
  const agent = createAgent(base);
  const password = username === 'superadmin' ? process.env.ADMIN_PASSWORD : process.env.DEMO_PASSWORD;
  const response = await agent.login(username, password);
  assert.equal(response.status, 302, response.text.slice(0, 160));
  return agent;
}

test('formula characters are prefixed before a csv cell is written', () => {
  for (const mark of ['=', '+', '-', '@']) {
    assert.equal(neutralizeCsv(`${mark}1`), `'${mark}1`);
  }
  assert.equal(neutralizeCsv('clerk'), 'clerk');
  assert.equal(neutralizeCsv(''), '');
});

test('scoped roles cannot read or change another branch', async () => {
  const clerk = await signed('clerk');
  const branch = await signed('branch.manager');
  const regional = await signed('regional.manager');
  const admin = await signed('superadmin');

  const places = await pool.query(`SELECT location_code, location_name, location_id FROM locations`);
  const place = Object.fromEntries(places.rows.map((row) => [row.location_code, row]));
  assert.ok(place.DEL, 'Delhi location');
  assert.ok(place.MUM, 'Mumbai location');

  const dash = await branch.get('/');
  assert.equal(dash.status, 200);
  assert.doesNotMatch(dash.text, /Delhi NCR|Pune|Ahmedabad|Hyderabad|ATM-DEL-|ATM-PUN-|ATM-HYD-/);
  assert.match(dash.text, /\/js\/dashboard\.js/);
  assert.doesNotMatch(dash.text, /<script>/);

  const regionalDash = await regional.get('/');
  assert.equal(regionalDash.status, 200);
  assert.doesNotMatch(regionalDash.text, /Delhi NCR|Hyderabad|Bengaluru Urban|ATM-DEL-|ATM-HYD-/);
  assert.match(regionalDash.text, /Mumbai Metro/);

  const adminDash = await admin.get('/');
  assert.match(adminDash.text, /Delhi NCR/);
  assert.match(adminDash.text, /Hyderabad/);

  const accuracy = await clerk.get('/forecast/accuracy');
  assert.equal(accuracy.status, 200);
  assert.doesNotMatch(accuracy.text, /ATM-DEL-/);
  const choices = accuracy.text.match(/ATM-[A-Z]{3}-/g) || [];
  assert.ok(choices.length > 0 && choices.length < 40, `expected a branch-sized ATM list, got ${choices.length}`);

  const delhiAtm = await pool.query(`SELECT atm_id FROM atms WHERE atm_code = 'ATM-DEL-0046'`);
  assert.equal(delhiAtm.rowCount, 1);
  assert.equal((await clerk.get(`/forecast/accuracy?atm_id=${delhiAtm.rows[0].atm_id}`)).status, 403);
  assert.equal((await clerk.get(`/forecast?atm_id=${delhiAtm.rows[0].atm_id}&date=2026-10-20`)).status, 403);

  const ownAtm = await pool.query(
    `SELECT a.atm_id FROM atms a
     JOIN users u ON u.username = 'clerk' AND u.branch_id = a.branch_id
     ORDER BY a.atm_id LIMIT 1`
  );
  assert.equal((await clerk.get(`/forecast/accuracy?atm_id=${ownAtm.rows[0].atm_id}`)).status, 200);

  const newRun = await clerk.get('/runs/new');
  assert.equal(newRun.status, 200);
  assert.doesNotMatch(newRun.text, /ATM-DEL-|Delhi NCR/);
  const newRecon = await clerk.get('/reconciliations/new');
  assert.equal(newRecon.status, 200);
  assert.doesNotMatch(newRecon.text, /ATM-DEL-|Delhi NCR/);
  const runList = await branch.get('/runs');
  assert.doesNotMatch(runList.text, /Delhi NCR/);

  const beforeRuns = await pool.query('SELECT COUNT(*)::int AS n FROM replenishment_runs');
  const created = await clerk.post('/runs', {
    planned_date: '2026-12-02',
    location_id: String(place.DEL.location_id),
    status: 'planned',
    atm_code: 'ATM-DEL-0046',
    cassette_number: '1',
    denomination: '500',
    note_count: '10',
  });
  assert.equal(created.status, 403);
  const slipped = await clerk.post('/runs', {
    planned_date: '2026-12-02',
    location_id: String(place.MUM.location_id),
    status: 'planned',
    atm_code: 'ATM-DEL-0046',
    cassette_number: '1',
    denomination: '500',
    note_count: '10',
  });
  assert.equal(slipped.status, 403);
  const afterRuns = await pool.query('SELECT COUNT(*)::int AS n FROM replenishment_runs');
  assert.equal(afterRuns.rows[0].n, beforeRuns.rows[0].n);

  const beforePlans = await pool.query(
    'SELECT COUNT(*)::int AS n FROM replenishment_plan_log WHERE location_id = $1',
    [place.DEL.location_id]
  );
  const planned = await branch.post('/runs/plan', {
    planned_date: '2026-12-03',
    location_id: String(place.DEL.location_id),
  });
  assert.equal(planned.status, 403);
  const afterPlans = await pool.query(
    'SELECT COUNT(*)::int AS n FROM replenishment_plan_log WHERE location_id = $1',
    [place.DEL.location_id]
  );
  assert.equal(afterPlans.rows[0].n, beforePlans.rows[0].n);

  await withRollback(async (client) => {
    const home = await client.query(
      `SELECT u.branch_id FROM users u WHERE u.username = 'branch.manager'`
    );
    await client.query(
      'CALL plan_replenishment_routes($1::date, NULL, 0, 0, $2::int, NULL)',
      ['2030-01-16', home.rows[0].branch_id]
    );
    const foreign = await client.query(
      `SELECT a.atm_code
       FROM cassette_loads cl
       JOIN replenishment_runs rr ON rr.run_id = cl.run_id
       JOIN atms a ON a.atm_id = cl.atm_id
       WHERE rr.planned_date = DATE '2030-01-16'
         AND a.branch_id <> $1`,
      [home.rows[0].branch_id]
    );
    assert.equal(foreign.rowCount, 0);
  });

  const outsideRun = await pool.query(
    `SELECT rr.run_id
     FROM replenishment_runs rr
     WHERE NOT EXISTS (
       SELECT 1 FROM cassette_loads cl
       JOIN atms a ON a.atm_id = cl.atm_id
       JOIN users u ON u.username = 'branch.manager'
       WHERE cl.run_id = rr.run_id AND a.branch_id = u.branch_id
     )
     AND NOT (
       NOT EXISTS (SELECT 1 FROM cassette_loads cl WHERE cl.run_id = rr.run_id)
       AND EXISTS (
         SELECT 1 FROM users u
         JOIN branches b ON b.branch_id = u.branch_id
         WHERE u.username = 'branch.manager' AND b.location_id = rr.location_id
       )
     )
     ORDER BY rr.run_id
     LIMIT 1`
  );
  assert.equal(outsideRun.rowCount, 1);
  const runId = outsideRun.rows[0].run_id;
  assert.equal((await branch.get(`/runs/${runId}`)).status, 403);
  const removed = await branch.post(`/runs/${runId}/delete`);
  assert.equal(removed.status, 403);
  const stillThere = await pool.query('SELECT 1 FROM replenishment_runs WHERE run_id = $1', [runId]);
  assert.equal(stillThere.rowCount, 1);

  const ownRun = await pool.query(
    `SELECT rr.run_id
     FROM replenishment_runs rr
     JOIN cassette_loads cl ON cl.run_id = rr.run_id
     JOIN atms a ON a.atm_id = cl.atm_id
     JOIN users u ON u.username = 'branch.manager' AND a.branch_id = u.branch_id
     ORDER BY rr.run_id
     LIMIT 1`
  );
  if (ownRun.rowCount) {
    const form = await admin.get(`/runs/${ownRun.rows[0].run_id}`);
    assert.equal(form.status, 200);
    assert.match(form.text, /data-confirm="Delete this run and its cassette loads\?"/);
    assert.doesNotMatch(form.text, /onsubmit=|onclick=/);
  }

  let outsideCase = await pool.query(
    `SELECT r.reconciliation_id
     FROM reconciliations r
     JOIN atms a ON a.atm_id = r.atm_id
     JOIN users u ON u.username = 'branch.manager'
     WHERE r.case_status IS NOT NULL AND a.branch_id <> u.branch_id
     ORDER BY r.reconciliation_id
     LIMIT 1`
  );
  let madeCase = false;
  if (!outsideCase.rowCount) {
    const inserted = await pool.query(
      `INSERT INTO reconciliations (atm_id, recon_date, expected_amount, counted_amount, notes)
       VALUES ($1, CURRENT_DATE, 1000, 900, 'scope probe')
       RETURNING reconciliation_id`,
      [delhiAtm.rows[0].atm_id]
    );
    outsideCase = inserted;
    madeCase = true;
  }
  const caseId = outsideCase.rows[0].reconciliation_id;
  try {
    assert.equal((await branch.get(`/reconciliations/${caseId}`)).status, 403);
    assert.equal((await clerk.get(`/reconciliations/${caseId}`)).status, 403);
    const notes = await pool.query(
      'SELECT COUNT(*)::int AS n FROM recon_comments WHERE reconciliation_id = $1',
      [caseId]
    );
    const comment = await clerk.post(`/reconciliations/${caseId}/comment`, { body: 'should not stick' });
    assert.equal(comment.status, 403);
    const notesAfter = await pool.query(
      'SELECT COUNT(*)::int AS n FROM recon_comments WHERE reconciliation_id = $1',
      [caseId]
    );
    assert.equal(notesAfter.rows[0].n, notes.rows[0].n);
    const status = await branch.post(`/reconciliations/${caseId}/status`, {
      case_status: 'resolved',
      reason_code: 'other',
    });
    assert.equal(status.status, 403);
  } finally {
    if (madeCase) {
      await pool.query('DELETE FROM fault_tickets WHERE reconciliation_id = $1', [caseId]);
      await pool.query('DELETE FROM reconciliations WHERE reconciliation_id = $1', [caseId]);
    }
  }

  const beforeCases = await pool.query('SELECT COUNT(*)::int AS n FROM reconciliations');
  const posted = await clerk.post('/reconciliations', {
    atm_id: String(delhiAtm.rows[0].atm_id),
    recon_date: '2026-10-27',
    expected_amount: '1000',
    counted_amount: '900',
    notes: 'out of scope',
  });
  assert.equal(posted.status, 403);
  const afterCases = await pool.query('SELECT COUNT(*)::int AS n FROM reconciliations');
  assert.equal(afterCases.rows[0].n, beforeCases.rows[0].n);

  const login = await fetch(`${base}/login`);
  const loginHtml = await login.text();
  assert.match(loginHtml, /id="password-toggle"/);
  assert.match(loginHtml, /src="\/js\/login.js"/);
  assert.doesNotMatch(loginHtml, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(loginHtml, /<script>/);
});

test('activity shows outcome and neutralizes formula cells', async () => {
  const marker = '=CONCAT("QA","-R6")';
  await pool.query(
    `INSERT INTO session_log (event, username, role, region)
     VALUES ('failure', $1, 'clerk', 'West')`,
    [marker]
  );
  await pool.query(
    `INSERT INTO access_log (username, role, method, page_name, path, outcome, status_code, region)
     VALUES ('scope.probe.r6', 'clerk', 'GET', 'User Accounts', $1, 'denied', 403, 'West')`,
    ['+probe']
  );

  const admin = await signed('superadmin');
  const denied = await admin.get('/activity?outcome=denied');
  assert.equal(denied.status, 200);
  assert.match(denied.text, /Outcome/);
  assert.match(denied.text, /scope\.probe\.r6/);
  assert.match(denied.text, />Denied</);
  assert.doesNotMatch(denied.text, /scope\.probe\.r6[\s\S]{0,80}>Allowed</);

  const failed = await admin.get('/activity?outcome=failed');
  assert.match(failed.text, /CONCAT/);
  assert.match(failed.text, />Failed</);

  const allowed = await admin.get('/activity?outcome=allowed');
  assert.doesNotMatch(allowed.text, /scope\.probe\.r6/);

  const csv = await admin.get('/activity/export?outcome=failed');
  assert.match(csv.text, /Outcome/);
  assert.match(csv.text, /"'=CONCAT\(""QA"",""-R6""\)"/);
  assert.match(csv.text, /Failed/);

  const deniedCsv = await admin.get('/activity/export?outcome=denied');
  assert.match(deniedCsv.text, /"'\+probe"/);
});
