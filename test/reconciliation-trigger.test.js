const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { ensureSchema, withRollback, makeAtm } = require('./helpers');

before(async () => {
  await ensureSchema();
});

test('a non-zero reconciliation raises a fault ticket and a match does not', async () => {
  await withRollback(async (client) => {
    const atm = await makeAtm(client);
    const mismatch = await client.query(
      `INSERT INTO reconciliations (atm_id, recon_date, expected_amount, counted_amount, notes)
       VALUES ($1, DATE '2026-10-20', 250000, 235000, 'counter short')
       RETURNING reconciliation_id, difference`,
      [atm.atmId]
    );
    assert.equal(Number(mismatch.rows[0].difference), -15000);
    const ticket = await client.query(
      `SELECT ticket_no, category, source, status, priority, reconciliation_id
       FROM fault_tickets WHERE reconciliation_id = $1`,
      [mismatch.rows[0].reconciliation_id]
    );
    assert.equal(ticket.rowCount, 1);
    assert.equal(ticket.rows[0].category, 'cash_variance');
    assert.equal(ticket.rows[0].source, 'trigger');
    assert.equal(ticket.rows[0].status, 'open');
    assert.equal(ticket.rows[0].priority, 'high');
    assert.match(ticket.rows[0].ticket_no, /^TKT-\d{6}$/);

    const matched = await client.query(
      `INSERT INTO reconciliations (atm_id, recon_date, expected_amount, counted_amount)
       VALUES ($1, DATE '2026-10-21', 250000, 250000)
       RETURNING reconciliation_id`,
      [atm.atmId]
    );
    const none = await client.query(
      'SELECT ticket_id FROM fault_tickets WHERE reconciliation_id = $1',
      [matched.rows[0].reconciliation_id]
    );
    assert.equal(none.rowCount, 0);
  });
});
