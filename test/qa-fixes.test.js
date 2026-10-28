const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { intOrNull, parseLedgerAmount, ledgerAmountError } = require('../src/http');
const { lastEightWeeks } = require('../src/lib/windows');
const { saveRun } = require('../src/services/runs');
const { ensureUsers, withRollback, makeAtm, pool, createAgent } = require('./helpers');

let server;
let base;
let agent;

function code(prefix) {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`.toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 14);
}

before(async () => {
  await ensureUsers();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  agent = createAgent(base);
  const logged = await agent.login();
  if (logged.status !== 302) throw new Error(`sign-in failed: ${logged.status} ${logged.text.slice(0, 180)}`);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function post(path, fields) {
  return agent.post(path, fields);
}

test('integer ids above the int4 range are rejected', () => {
  assert.equal(intOrNull('2147483647'), 2147483647);
  assert.equal(intOrNull(2147483647), 2147483647);
  assert.equal(intOrNull('2147483648'), null);
  assert.equal(intOrNull('99999999999'), null);
  assert.equal(intOrNull(''), null);
  assert.equal(intOrNull('0'), null);
  assert.equal(intOrNull('-4'), null);
});

test('ledger amounts stay inside numeric(14,2)', () => {
  assert.equal(parseLedgerAmount('999999999999.99'), '999999999999.99');
  assert.equal(parseLedgerAmount('0'), '0');
  assert.equal(parseLedgerAmount('1000000000000'), null);
  assert.equal(parseLedgerAmount('99999999999999999'), null);
  assert.equal(ledgerAmountError('99999999999999999', 'Expected amount'), 'Amount too large.');
  assert.match(ledgerAmountError('-5', 'Expected amount'), /up to 2 decimal places/);
});

test('the last eight weeks are 56 days ending yesterday, eight of each weekday', async () => {
  const pred = lastEightWeeks('day');
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE ${pred})::int AS included,
       BOOL_OR(day = CURRENT_DATE) FILTER (WHERE ${pred}) AS includes_today,
       BOOL_OR(day = CURRENT_DATE - 1) FILTER (WHERE ${pred}) AS includes_yesterday,
       BOOL_OR(day = CURRENT_DATE - 56) FILTER (WHERE ${pred}) AS includes_start,
       BOOL_OR(day = CURRENT_DATE - 57) FILTER (WHERE ${pred}) AS includes_extra,
       COUNT(DISTINCT EXTRACT(DOW FROM day)) FILTER (WHERE ${pred})::int AS weekdays,
       MIN(cnt) AS shortest,
       MAX(cnt) AS longest
     FROM generate_series(CURRENT_DATE - 80, CURRENT_DATE + 2, interval '1 day') AS gs(day)
     CROSS JOIN LATERAL (
       SELECT COUNT(*)::int AS cnt
       FROM generate_series(CURRENT_DATE - 80, CURRENT_DATE + 2, interval '1 day') AS inner_day
       WHERE ${lastEightWeeks('inner_day')}
         AND EXTRACT(DOW FROM inner_day) = EXTRACT(DOW FROM day)
     ) AS per_dow`
  );
  const row = result.rows[0];
  assert.equal(row.included, 56);
  assert.equal(row.includes_today, false);
  assert.equal(row.includes_yesterday, true);
  assert.equal(row.includes_start, true);
  assert.equal(row.includes_extra, false);
  assert.equal(row.weekdays, 7);
  assert.equal(row.shortest, 8);
  assert.equal(row.longest, 8);
});

async function addVan(client, locationId) {
  const van = await client.query(
    `INSERT INTO cash_vans (location_id, van_code, registration_no, capacity_amount, status)
     VALUES ($1, $2, $3, 20000000, 'available')
     RETURNING van_id`,
    [locationId, code('V'), code('R')]
  );
  const custodian = await client.query(
    `INSERT INTO custodians (van_id, employee_code, full_name, phone, active)
     VALUES ($1, $2, 'Test Custodian', '+91 9800000000', TRUE)
     RETURNING custodian_id`,
    [van.rows[0].van_id, code('C')]
  );
  return { vanId: van.rows[0].van_id, custodianId: custodian.rows[0].custodian_id };
}

async function addRun(client, { vanId, custodianId, locationId, atmId, dayOffset, status }) {
  const run = await client.query(
    `INSERT INTO replenishment_runs (van_id, custodian_id, location_id, planned_date, status, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE + $4::int, $5, 'operator')
     RETURNING run_id`,
    [vanId, custodianId, locationId, dayOffset, status]
  );
  await client.query(
    `INSERT INTO cassette_loads (run_id, atm_id, cassette_number, denomination, note_count, amount)
     VALUES ($1, $2, 1, 500, 10, 5000)`,
    [run.rows[0].run_id, atmId]
  );
  return run.rows[0].run_id;
}

test('a cash-out counts once, for the van that last serviced the ATM on or before that day', async () => {
  await withRollback(async (client) => {
    const atm = await makeAtm(client);
    const earlier = await addVan(client, atm.locationId);
    const later = await addVan(client, atm.locationId);
    const future = await addVan(client, atm.locationId);
    await addRun(client, {
      ...earlier,
      locationId: atm.locationId,
      atmId: atm.atmId,
      dayOffset: -20,
      status: 'completed',
    });
    const laterRun = await addRun(client, {
      ...later,
      locationId: atm.locationId,
      atmId: atm.atmId,
      dayOffset: -5,
      status: 'completed',
    });
    await addRun(client, {
      ...future,
      locationId: atm.locationId,
      atmId: atm.atmId,
      dayOffset: 8,
      status: 'planned',
    });
    await client.query(
      `INSERT INTO fault_tickets (atm_id, title, category, priority, status, source, opened_at)
       VALUES ($1, 'Empty cassette', 'cash_out', 'high', 'open', 'manual', CURRENT_TIMESTAMP - interval '1 day')`,
      [atm.atmId]
    );

    const onlyFutureAtm = await makeAtm(client);
    const futureOnly = await addVan(client, onlyFutureAtm.locationId);
    await addRun(client, {
      ...futureOnly,
      locationId: onlyFutureAtm.locationId,
      atmId: onlyFutureAtm.atmId,
      dayOffset: 10,
      status: 'planned',
    });
    await client.query(
      `INSERT INTO fault_tickets (atm_id, title, category, priority, status, source, opened_at)
       VALUES ($1, 'Empty cassette', 'cash_out', 'high', 'open', 'manual', CURRENT_TIMESTAMP - interval '1 day')`,
      [onlyFutureAtm.atmId]
    );

    const counts = await client.query(
      `SELECT van_id, cashout_incidents, atms_on_route
       FROM v_van_cashout_incidents
       WHERE van_id = ANY($1::int[])`,
      [[earlier.vanId, later.vanId, future.vanId, futureOnly.vanId]]
    );
    const byVan = new Map(counts.rows.map((row) => [row.van_id, row]));
    assert.equal(Number(byVan.get(earlier.vanId).cashout_incidents), 0);
    assert.equal(Number(byVan.get(later.vanId).cashout_incidents), 1);
    assert.equal(Number(byVan.get(future.vanId).cashout_incidents), 0);
    assert.equal(Number(byVan.get(futureOnly.vanId).cashout_incidents), 0);
    assert.equal(Number(byVan.get(future.vanId).atms_on_route), 1);
    assert.equal(Number(byVan.get(later.vanId).atms_on_route), 1);
    assert.ok(laterRun);
  });
});

test('a run rejects an ATM already loaded that day and a load over capacity', async () => {
  await withRollback(async (client) => {
    const atm = await makeAtm(client, { capacity: 50000, cash: 1000 });
    const crew = await addVan(client, atm.locationId);
    const other = await addVan(client, atm.locationId);
    const body = {
      planned_date: '2026-11-03',
      location_id: String(atm.locationId),
      van_id: String(crew.vanId),
      custodian_id: String(crew.custodianId),
      status: 'planned',
      atm_code: atm.atmCode,
      cassette_number: '1',
      denomination: '2000',
      note_count: '10',
    };
    const first = await saveRun(client, body, null);
    assert.ok(first.runId);
    assert.equal(first.errors, undefined);

    const duplicate = await saveRun(client, {
      ...body,
      van_id: String(other.vanId),
      custodian_id: String(other.custodianId),
    }, null);
    assert.ok(duplicate.errors.some((error) => error.includes(`${atm.atmCode} is already on run ${first.runId} for 2026-11-03`)));

    const edited = await saveRun(client, body, first.runId);
    assert.equal(edited.runId, first.runId);

    const withinRoom = await saveRun(client, { ...body, planned_date: '2026-11-04', note_count: '24' }, null);
    assert.equal(withinRoom.errors, undefined);
    assert.ok(withinRoom.runId);

    const overRoom = await saveRun(client, { ...body, planned_date: '2026-11-05', note_count: '25' }, null);
    assert.ok(overRoom.errors.some((error) => error.includes(`${atm.atmCode}: load exceeds remaining ATM capacity`)));
    assert.ok(overRoom.errors.some((error) => error.includes('₹49,000 still available of ₹50,000')));

    const cancelled = await saveRun(client, {
      ...body,
      van_id: String(other.vanId),
      custodian_id: String(other.custodianId),
      status: 'cancelled',
    }, null);
    assert.equal(cancelled.errors, undefined);
    assert.ok(cancelled.runId);

    const cancelExisting = await saveRun(client, { ...body, status: 'cancelled' }, first.runId);
    assert.equal(cancelExisting.runId, first.runId);

    await client.query(`UPDATE cash_vans SET status = 'maintenance' WHERE van_id = $1`, [other.vanId]);
    const maintenance = await saveRun(client, {
      ...body,
      planned_date: '2026-11-06',
      van_id: String(other.vanId),
      custodian_id: String(other.custodianId),
      status: 'planned',
    }, null);
    assert.ok(maintenance.errors.some((error) => /in maintenance/i.test(error)));

    const afterCancel = await saveRun(client, body, null);
    assert.equal(afterCancel.errors, undefined);
    assert.ok(afterCancel.runId);
  });
});

test('oversized ids, money, dates, and missing rows are validation errors', async () => {
  const atm = await pool.query('SELECT atm_id FROM atms ORDER BY atm_id LIMIT 1');
  const atmId = String(atm.rows[0].atm_id);
  const today = await pool.query('SELECT CURRENT_DATE::text AS today');
  const missingRun = await pool.query('SELECT 1 FROM replenishment_runs WHERE run_id = 2147483647');
  assert.equal(missingRun.rowCount, 0);

  const missingAtm = await agent.get('/atms/99999999999');
  assert.equal(missingAtm.status, 404);

  const forecast = await agent.get('/forecast?atm_id=99999999999');
  const forecastText = forecast.text;
  assert.equal(forecast.status, 200);
  assert.match(forecastText, /Choose an ATM/);
  assert.doesNotMatch(forecastText, /database may still be loading/);

  const hugeMoney = await post('/reconciliations', {
    atm_id: atmId,
    recon_date: today.rows[0].today,
    expected_amount: '99999999999999999',
    counted_amount: '99999999999999999',
  });
  assert.equal(hugeMoney.status, 400);
  assert.match(hugeMoney.text, /Amount too large/);

  const future = await post('/reconciliations', {
    atm_id: atmId,
    recon_date: '2099-12-31',
    expected_amount: '100',
    counted_amount: '100',
  });
  assert.equal(future.status, 400);
  assert.match(future.text, /Reconciliation date is in the future/);
  const futureRows = await pool.query(`SELECT COUNT(*)::int AS n FROM reconciliations WHERE recon_date = DATE '2099-12-31'`);
  assert.equal(futureRows.rows[0].n, 0);

  const deleted = await post('/runs/2147483647/delete', {});
  assert.equal(deleted.status, 302);
  assert.match(deleted.location, /That run was not found/);
  assert.doesNotMatch(deleted.location, /Replenishment run deleted/);

  const badPlan = await post('/runs/plan', { planned_date: '2026-11-03', location_id: '999' });
  assert.equal(badPlan.status, 302);
  assert.match(badPlan.location, /Choose a valid location/);
  assert.doesNotMatch(badPlan.location, /foreign key|violates/i);

  const overflowPlan = await post('/runs/plan', { planned_date: '2026-11-03', location_id: '99999999999' });
  assert.equal(overflowPlan.status, 302);
  assert.match(overflowPlan.location, /Choose a valid location/);

  const closeMissing = await post('/tickets/2147483647/close', { resolution: 'done' });
  assert.equal(closeMissing.status, 302);
  assert.match(closeMissing.location, /Ticket not found/);
  assert.doesNotMatch(closeMissing.location, /already closed/);

  const assignMissing = await post('/tickets/99999999999/assign', { engineer_id: '1' });
  assert.equal(assignMissing.status, 302);
  assert.match(assignMissing.location, /Ticket not found/);

  const openTicket = await pool.query(
    `SELECT ticket_id FROM fault_tickets WHERE status <> 'closed' ORDER BY ticket_id LIMIT 1`
  );
  assert.ok(openTicket.rowCount > 0);
  const ticketId = String(openTicket.rows[0].ticket_id);
  const assignEngineer = await post(`/tickets/${ticketId}/assign`, { engineer_id: '2147483647' });
  assert.equal(assignEngineer.status, 302);
  assert.match(assignEngineer.location, /Engineer not found/);
  const assignEmpty = await post(`/tickets/${ticketId}/assign`, { engineer_id: '' });
  assert.equal(assignEmpty.status, 302);
  assert.match(assignEmpty.location, /Choose an engineer before assigning the ticket/);

  const hugeVan = await post('/runs', {
    planned_date: '2026-11-03',
    location_id: '99999999999',
    van_id: '99999999999',
    custodian_id: '99999999999',
    status: 'planned',
    atm_code: 'ATM-MUM-0001',
    cassette_number: '1',
    denomination: '2000',
    note_count: '1',
  });
  assert.equal(hugeVan.status, 400);
  assert.match(hugeVan.text, /Choose a location/);
  assert.doesNotMatch(hugeVan.text, /database may still be loading/);

  const beforeRecon = await pool.query('SELECT COUNT(*)::int AS n FROM reconciliations');
  for (const runId of ['99999999999', 'abc']) {
    const badRun = await post('/reconciliations', {
      atm_id: atmId,
      run_id: runId,
      recon_date: today.rows[0].today,
      expected_amount: '100',
      counted_amount: '100',
      notes: `bad-run-${runId}`,
    });
    assert.equal(badRun.status, 400);
    assert.match(badRun.text, /That replenishment run does not exist/);
  }
  const afterRecon = await pool.query('SELECT COUNT(*)::int AS n FROM reconciliations');
  assert.equal(afterRecon.rows[0].n, beforeRecon.rows[0].n);

  const maint = await pool.query(`SELECT van_code FROM cash_vans WHERE status = 'maintenance' LIMIT 1`);
  assert.ok(maint.rowCount > 0);
  const runForm = await agent.get('/runs/new');
  const runHtml = runForm.text;
  assert.equal(runForm.status, 200);
  assert.doesNotMatch(runHtml, new RegExp(maint.rows[0].van_code));

  const cashouts = await agent.get('/reports/van-cashouts');
  const cashoutHtml = cashouts.text;
  assert.match(cashoutHtml, /counted once, against the van that last serviced/);

  const home = await agent.get('/');
  const homeHtml = home.text;
  const ticketLink = homeHtml.match(/href="\/tickets\?ticket=(\d+)#ticket-\1"/);
  assert.ok(ticketLink);
  const focused = await agent.get(`/tickets?ticket=${ticketLink[1]}`);
  const focusedHtml = focused.text;
  assert.match(focusedHtml, new RegExp(`id="ticket-${ticketLink[1]}" class="row-focus"`));
});
