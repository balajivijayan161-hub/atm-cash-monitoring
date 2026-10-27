const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { ensureSchema, withRollback, makeAtm } = require('./helpers');

before(async () => {
  await ensureSchema();
});

test('forecast_cash averages the same weekday across the prior 28 days', async () => {
  await withRollback(async (client) => {
    const atm = await makeAtm(client);
    const rows = [
      ['2026-09-25', 900000],
      ['2026-10-02', 100000],
      ['2026-10-09', 80000],
      ['2026-10-16', 120000],
      ['2026-10-23', 100000],
      ['2026-10-29', 999999],
      ['2026-10-30', 777777],
    ];
    for (const [date, amount] of rows) {
      await client.query(
        `INSERT INTO daily_withdrawals (atm_id, withdrawal_date, amount, txn_count, source)
         VALUES ($1, $2, $3, 10, 'manual')`,
        [atm.atmId, date, amount]
      );
    }
    const forecast = await client.query(
      'SELECT forecast_cash($1, $2::date) AS forecast',
      [atm.atmId, '2026-10-30']
    );
    assert.equal(Number(forecast.rows[0].forecast), 100000);

    const points = await client.query(
      'SELECT withdrawal_date::text AS withdrawal_date, amount FROM forecast_cash_points($1, $2::date)',
      [atm.atmId, '2026-10-30']
    );
    assert.deepEqual(points.rows.map((row) => row.withdrawal_date), [
      '2026-10-02',
      '2026-10-09',
      '2026-10-16',
      '2026-10-23',
    ]);
    const average = points.rows.reduce((sum, row) => sum + Number(row.amount), 0) / points.rows.length;
    assert.equal(average, Number(forecast.rows[0].forecast));
  });
});

test('forecast_cash returns zero when that weekday has no history', async () => {
  await withRollback(async (client) => {
    const atm = await makeAtm(client);
    const forecast = await client.query(
      'SELECT forecast_cash($1, DATE \'2026-10-30\') AS forecast',
      [atm.atmId]
    );
    assert.equal(Number(forecast.rows[0].forecast), 0);
  });
});
