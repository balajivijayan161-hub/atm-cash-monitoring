const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lineAmount, totalLoaded } = require('../public/js/money');
const { normalizeLoads } = require('../src/lib/loads');

test('total loaded is the sum of denomination times note count', () => {
  assert.equal(lineAmount(500, 10), 5000);
  assert.equal(lineAmount('2000', '3'), 6000);
  assert.equal(lineAmount('nope', 4), 0);
  const lines = [
    { denomination: 100, noteCount: 10 },
    { denomination: 200, note_count: 5 },
    { denomination: 500, noteCount: 4 },
    { denomination: 2000, noteCount: 3 },
  ];
  assert.equal(totalLoaded(lines), 100 * 10 + 200 * 5 + 500 * 4 + 2000 * 3);
  assert.equal(totalLoaded([]), 0);
});

test('the replenishment form uses that total and rejects a duplicate cassette', () => {
  const saved = normalizeLoads({
    atm_code: ['ATM-MUM-0001', 'atm-mum-0001'],
    cassette_number: ['1', '4'],
    denomination: ['500', '2000'],
    note_count: ['10', '3'],
  });
  assert.deepEqual(saved.errors, []);
  assert.equal(saved.total, 500 * 10 + 2000 * 3);
  assert.equal(saved.lines[1].atmCode, 'ATM-MUM-0001');

  const duplicate = normalizeLoads({
    atm_code: ['ATM-MUM-0001', 'ATM-MUM-0001'],
    cassette_number: ['2', '2'],
    denomination: ['200', '200'],
    note_count: ['5', '8'],
  });
  assert.ok(duplicate.errors.some((error) => /already listed/i.test(error)));
});
