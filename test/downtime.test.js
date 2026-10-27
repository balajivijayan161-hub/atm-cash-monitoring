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
  });
});
