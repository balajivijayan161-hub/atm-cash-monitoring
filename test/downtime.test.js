const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { ensureSchema, withRollback, makeAtm } = require('./helpers');

before(async () => {
  await ensureSchema();
});

test('the downtime view keeps ATMs strictly above 5 percent', async () => {
  await withRollback(async (client) => {
    const elapsedRow = await client.query(
      `SELECT EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - date_trunc('month', CURRENT_TIMESTAMP))) / 60.0 AS elapsed`
    );
    const elapsed = Math.max(Number(elapsedRow.rows[0].elapsed), 1);
    const high = await makeAtm(client, { cash: 50000 });
    const low = await makeAtm(client, { cash: 50000 });
    await client.query(
      `INSERT INTO downtime_log (atm_id, started_at, ended_at, reason)
       VALUES
         ($1, date_trunc('month', CURRENT_TIMESTAMP),
          date_trunc('month', CURRENT_TIMESTAMP) + ($3::numeric * interval '1 minute'), 'hardware'),
         ($2, date_trunc('month', CURRENT_TIMESTAMP),
          date_trunc('month', CURRENT_TIMESTAMP) + ($4::numeric * interval '1 minute'), 'power')`,
      [high.atmId, low.atmId, elapsed * 0.08, elapsed * 0.02]
    );

    const listed = await client.query(
      `SELECT atm_id, downtime_pct FROM v_atm_downtime_above_5pct WHERE atm_id = ANY($1::int[])`,
      [[high.atmId, low.atmId]]
    );
    const ids = listed.rows.map((row) => row.atm_id);
    assert.ok(ids.includes(high.atmId), '8% downtime should be listed');
    assert.equal(ids.includes(low.atmId), false, '2% downtime should stay off the list');

    const detail = await client.query(
      `SELECT atm_id, downtime_pct FROM v_atm_downtime_mtd WHERE atm_id = ANY($1::int[])`,
      [[high.atmId, low.atmId]]
    );
    const byId = new Map(detail.rows.map((row) => [row.atm_id, Number(row.downtime_pct)]));
    assert.ok(byId.get(high.atmId) > 5);
    assert.ok(byId.get(low.atmId) < 5);
    assert.ok(byId.get(high.atmId) <= 100);
    assert.ok(byId.get(low.atmId) >= 0);
  });
});

test('overlapping downtime is merged and clamped between 0 and 100 percent', async () => {
  await withRollback(async (client) => {
    const atm = await makeAtm(client, { cash: 50000 });
    await client.query(
      `INSERT INTO downtime_log (atm_id, started_at, ended_at, reason, notes)
       VALUES
         ($1, date_trunc('month', CURRENT_TIMESTAMP), NULL, 'hardware', 'first outage'),
         ($1, date_trunc('month', CURRENT_TIMESTAMP) + interval '1 minute', NULL, 'communication', 'overlapping outage')`,
      [atm.atmId]
    );
    const row = await client.query(
      `SELECT downtime_pct, downtime_minutes, elapsed_minutes
       FROM v_atm_downtime_mtd WHERE atm_id = $1`,
      [atm.atmId]
    );
    const pct = Number(row.rows[0].downtime_pct);
    const minutes = Number(row.rows[0].downtime_minutes);
    const elapsed = Number(row.rows[0].elapsed_minutes);
    assert.ok(pct >= 0 && pct <= 100);
    assert.ok(100 - pct >= 0);
    assert.ok(minutes <= elapsed + 0.2);
    assert.ok(pct > 99, `fully covered month should stay near 100, got ${pct}`);
  });
});
