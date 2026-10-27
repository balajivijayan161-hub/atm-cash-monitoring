const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { ensureSchema, withRollback, makeAtm } = require('./helpers');

before(async () => {
  await ensureSchema();
});

test('plan_replenishment_routes loads only ATMs whose forecast exceeds remaining cash', async () => {
  await withRollback(async (client) => {
    const low = await makeAtm(client, { cash: 10000, capacity: 2000000 });
    const high = await client.query(
      `INSERT INTO atms (
         branch_id, atm_code, site_name, address, status, installed_on, capacity_amount, current_cash
       ) VALUES ($1, $2, 'Healthy lobby', '1 Test Road', 'active', DATE '2020-01-01', 6000000, 5000000)
       RETURNING atm_id`,
      [low.branchId, `${low.atmCode}-H`]
    );
    const highId = high.rows[0].atm_id;
    for (const atmId of [low.atmId, highId]) {
      for (const [date, amount] of [
        ['2026-10-02', 100000],
        ['2026-10-09', 80000],
        ['2026-10-16', 120000],
        ['2026-10-23', 100000],
      ]) {
        await client.query(
          `INSERT INTO daily_withdrawals (atm_id, withdrawal_date, amount, txn_count, source)
           VALUES ($1, $2, $3, 12, 'manual')`,
          [atmId, date, amount]
        );
      }
    }
    const van = await client.query(
      `INSERT INTO cash_vans (location_id, van_code, registration_no, capacity_amount, status)
       VALUES ($1, $2, $3, 20000000, 'available')
       RETURNING van_id`,
      [low.locationId, `VAN-${low.locationId}`, `REG-${low.locationId}`]
    );
    await client.query(
      `INSERT INTO custodians (van_id, employee_code, full_name, phone, active)
       VALUES ($1, $2, 'Test Custodian', '+91 9800000000', TRUE)`,
      [van.rows[0].van_id, `CST${low.locationId}`]
    );

    await client.query(
      'CALL plan_replenishment_routes($1::date, $2::int, 0, 0)',
      ['2026-10-30', low.locationId]
    );
    const first = await client.query(
      `SELECT cl.atm_id, cl.denomination, cl.note_count, cl.amount
       FROM cassette_loads cl
       JOIN replenishment_runs rr ON rr.run_id = cl.run_id
       WHERE rr.location_id = $1 AND rr.planned_date = DATE '2026-10-30'`,
      [low.locationId]
    );
    const lowLoads = first.rows.filter((row) => row.atm_id === low.atmId);
    const highLoads = first.rows.filter((row) => row.atm_id === highId);
    assert.ok(lowLoads.length > 0);
    assert.equal(highLoads.length, 0);
    for (const load of lowLoads) {
      assert.equal(Number(load.amount), Number(load.denomination) * Number(load.note_count));
    }
    const run = await client.query(
      `SELECT van_id, custodian_id, created_by FROM replenishment_runs
       WHERE location_id = $1 AND planned_date = DATE '2026-10-30'`,
      [low.locationId]
    );
    assert.equal(run.rows[0].created_by, 'plan_replenishment_routes');
    assert.equal(run.rows[0].van_id, van.rows[0].van_id);

    await client.query(
      'CALL plan_replenishment_routes($1::date, $2::int, 0, 0)',
      ['2026-10-30', low.locationId]
    );
    const second = await client.query(
      `SELECT COUNT(*)::int AS loads
       FROM cassette_loads cl
       JOIN replenishment_runs rr ON rr.run_id = cl.run_id
       WHERE cl.atm_id = $1 AND rr.planned_date = DATE '2026-10-30'`,
      [low.atmId]
    );
    assert.equal(second.rows[0].loads, lowLoads.length);
  });
});
