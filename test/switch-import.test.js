const fs = require('fs');
const path = require('path');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { parseSwitchFile, formatFixedLine, FIXED_LENGTH } = require('../src/lib/switchFile');
const { importSwitchContent } = require('../src/services/switchImport');
const { ensureSchema, withRollback, makeAtm } = require('./helpers');

before(async () => {
  await ensureSchema();
});

test('the sample CSV is validated before any database lookup', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'samples', 'switch_transactions.csv'), 'utf8');
  const parsed = parseSwitchFile(content, { today: '2026-10-27' });
  assert.equal(parsed.format, 'csv');
  assert.equal(parsed.fileError, null);
  const errors = parsed.rows.filter((row) => row.error);
  assert.equal(errors.length, 3);
  assert.match(errors[0].error, /Duplicate/);
  assert.match(parsed.rows[4].error, /date/i);
  assert.match(parsed.rows[5].error, /negative/i);
  assert.equal(parsed.rows[0].amount, 150000);
});

test('fixed-width rows are 42 characters and reject a short line', () => {
  const line = formatFixedLine({
    atmCode: 'ATM-MUM-0001',
    txnDate: '2024-11-01',
    amount: 220000,
    txnCount: 61,
  });
  assert.equal(line.length, FIXED_LENGTH);
  const parsed = parseSwitchFile(`${line}\nTOO SHORT\n`, { today: '2026-10-27' });
  assert.equal(parsed.format, 'fixed');
  assert.equal(parsed.rows[0].error, null);
  assert.equal(parsed.rows[0].amount, 220000);
  assert.equal(parsed.rows[0].txnCount, 61);
  assert.match(parsed.rows[1].error, /42 characters/);
});

test('a switch file is staged, loaded, and keeps error rows', async () => {
  await withRollback(async (client) => {
    const atm = await makeAtm(client, { code: `ATM-${Date.now().toString(36).toUpperCase()}`.slice(0, 16) });
    const csv = [
      'atm_code,txn_date,amount,txn_count',
      `${atm.atmCode},2024-11-03,150000,40`,
      'NO-SUCH-ATM,2024-11-03,1000,1',
      `${atm.atmCode},2024-11-03,10,1`,
      `${atm.atmCode},not-a-date,10,1`,
      `${atm.atmCode},2024-11-04,-5,1`,
    ].join('\n');
    const result = await importSwitchContent(client, {
      filename: 'switch.csv',
      content: csv,
      replaceExisting: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.loaded, 1);
    assert.equal(result.errors, 4);
    assert.equal(result.status, 'loaded_with_errors');

    const posted = await client.query(
      `SELECT amount, txn_count, source FROM daily_withdrawals WHERE atm_id = $1 AND withdrawal_date = DATE '2024-11-03'`,
      [atm.atmId]
    );
    assert.equal(posted.rowCount, 1);
    assert.equal(Number(posted.rows[0].amount), 150000);
    assert.equal(posted.rows[0].source, 'switch');

    const staged = await client.query(
      `SELECT status, error_message FROM switch_import_rows WHERE batch_id = $1 ORDER BY line_no`,
      [result.batchId]
    );
    assert.equal(staged.rows.filter((row) => row.status === 'error').length, 4);
    assert.equal(staged.rows.filter((row) => row.status === 'loaded').length, 1);
    assert.match(staged.rows[1].error_message, /Unknown ATM/);
  });
});
