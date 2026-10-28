const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pageWindow } = require('../src/http');
const { parseSwitchFile } = require('../src/lib/switchFile');
const { importSwitchContent } = require('../src/services/switchImport');
const { rowUpdatesCurrentState, closeLiveFeedDowntime } = require('../src/services/ingestionRules');
const { ingestTracked, scanInboundOnce, classifyIngestResult } = require('../src/services/inboundPoller');
const { runSimulatorTick, shouldAutoStop } = require('../src/services/simulator');
const { ensureSchema, withRollback, makeAtm, pool } = require('./helpers');

let server;
let base;

before(async () => {
  await ensureSchema();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function feedCsv(atm, fields) {
  return [
    'atm_code,txn_date,amount,txn_count,cash_level,fault_code,online',
    [
      atm.atmCode,
      fields.date || '2024-08-01',
      fields.amount == null ? '1500' : String(fields.amount),
      '3',
      fields.cash == null ? '' : String(fields.cash),
      fields.fault || '',
      fields.online == null ? '' : fields.online,
    ].join(','),
  ].join('\n');
}

test('optional switch columns do not change the original CSV shape', () => {
  const parsed = parseSwitchFile('atm_code,txn_date,amount,txn_count\nATM-MUM-0001,2024-08-01,10,1\n', { today: '2026-10-28' });
  assert.equal(parsed.rows[0].error, null);
  assert.equal(parsed.rows[0].cashLevel, undefined);
  const extended = parseSwitchFile(
    'atm_code,txn_date,amount,txn_count,cash_level,fault_code,online\nATM-MUM-0001,2024-08-01,10,1,-5,not-a-fault,maybe\n',
    { today: '2026-10-28' }
  );
  assert.match(extended.rows[0].error, /negative/i);
  assert.match(extended.rows[0].error, /Unknown fault code/);
  assert.match(extended.rows[0].error, /Online flag/);
});

test('the live feed stops itself after the cap and not before', () => {
  assert.equal(shouldAutoStop(1_000, 1_000 + 15 * 60 * 1000, 15 * 60 * 1000), true);
  assert.equal(shouldAutoStop(1_000, 1_000 + 14 * 60 * 1000, 15 * 60 * 1000), false);
  assert.equal(classifyIngestResult({ ok: true, loaded: 2 }), 'processed');
  assert.equal(classifyIngestResult({ ok: true, duplicate: true, loaded: 0 }), 'processed');
  assert.equal(classifyIngestResult({ ok: true, loaded: 0 }), 'rejected');
  assert.equal(classifyIngestResult({ ok: false }), 'rejected');
  assert.equal(rowUpdatesCurrentState('2024-08-02', null, '2026-10-28'), false);
  assert.equal(rowUpdatesCurrentState('2026-10-28', null, '2026-10-28'), true);
  assert.equal(rowUpdatesCurrentState('2024-08-02', '2026-10-28', '2026-10-28'), false);
  assert.equal(rowUpdatesCurrentState('2026-10-28', '2026-10-28', '2026-10-28'), true);
  const window = pageWindow(3, 80, 200);
  assert.equal(window.page, 3);
  assert.equal(window.pages, 3);
  assert.equal(window.offset, 160);
  assert.equal(pageWindow(9, 80, 10).page, 1);
});

test('ingestion raises one cash alert, one ticket per fault, and downtime only after the offline threshold', async () => {
  await withRollback(async (client) => {
    const atm = await makeAtm(client, { capacity: 300000, cash: 80000 });
    const today = (await client.query('SELECT CURRENT_DATE::text AS today')).rows[0].today;
    const pastOnly = await importSwitchContent(client, {
      filename: 'past.csv',
      content: feedCsv(atm, { cash: 250000, date: '2024-08-02', fault: 'hardware' }),
      replaceExisting: false,
      rules: { cashThresholdPct: 20, offlineMinutes: 0 },
    });
    assert.equal(pastOnly.loaded, 1);
    const afterPast = await client.query('SELECT current_cash FROM atms WHERE atm_id = $1', [atm.atmId]);
    assert.equal(Number(afterPast.rows[0].current_cash), 80000);
    const pastAlerts = await client.query(
      `SELECT COUNT(*)::int AS n FROM replenishment_requests WHERE atm_id = $1`,
      [atm.atmId]
    );
    assert.equal(pastAlerts.rows[0].n, 0);
    const pastTickets = await client.query(
      `SELECT COUNT(*)::int AS n FROM fault_tickets WHERE atm_id = $1`,
      [atm.atmId]
    );
    assert.equal(pastTickets.rows[0].n, 0);
    const history = await client.query(
      `SELECT COUNT(*)::int AS n FROM daily_withdrawals WHERE atm_id = $1 AND withdrawal_date = DATE '2024-08-02'`,
      [atm.atmId]
    );
    assert.equal(history.rows[0].n, 1);

    const mixed = [
      'atm_code,txn_date,amount,txn_count,cash_level,fault_code,online',
      `${atm.atmCode},${today},1500,3,10000,,`,
      `${atm.atmCode},2024-01-15,1500,3,250000,,`,
    ].join('\n');
    const ordered = await importSwitchContent(client, {
      filename: 'mixed.csv',
      content: mixed,
      replaceExisting: false,
      rules: { cashThresholdPct: 20, offlineMinutes: 30 },
    });
    assert.equal(ordered.loaded, 2);
    const afterMix = await client.query('SELECT current_cash FROM atms WHERE atm_id = $1', [atm.atmId]);
    assert.equal(Number(afterMix.rows[0].current_cash), 10000);

    const low = await importSwitchContent(client, {
      filename: 'low.csv',
      content: feedCsv(atm, { cash: 10000, date: today }),
      replaceExisting: true,
      rules: { cashThresholdPct: 20, offlineMinutes: 30 },
    });
    assert.equal(low.loaded, 1);
    const again = await importSwitchContent(client, {
      filename: 'low-again.csv',
      content: feedCsv(atm, { cash: 9000, date: today }),
      replaceExisting: true,
      rules: { cashThresholdPct: 20, offlineMinutes: 30 },
    });
    assert.equal(again.loaded, 1);
    const requests = await client.query(
      `SELECT COUNT(*)::int AS n, MIN(current_cash) AS cash
       FROM replenishment_requests WHERE atm_id = $1 AND status = 'open'`,
      [atm.atmId]
    );
    assert.equal(requests.rows[0].n, 1);
    assert.equal(Number(requests.rows[0].cash), 9000);

    const restored = await importSwitchContent(client, {
      filename: 'restored.csv',
      content: feedCsv(atm, { cash: 250000, date: today }),
      replaceExisting: true,
      rules: { cashThresholdPct: 20, offlineMinutes: 30 },
    });
    assert.equal(restored.loaded, 1);
    const closed = await client.query(
      `SELECT COUNT(*)::int AS n FROM replenishment_requests WHERE atm_id = $1 AND status = 'open'`,
      [atm.atmId]
    );
    assert.equal(closed.rows[0].n, 0);

    await importSwitchContent(client, {
      filename: 'fault.csv',
      content: feedCsv(atm, { date: today, fault: 'hardware' }),
      replaceExisting: true,
      rules: { cashThresholdPct: 20, offlineMinutes: 30 },
    });
    await importSwitchContent(client, {
      filename: 'fault-again.csv',
      content: feedCsv(atm, { date: today, fault: 'hardware' }),
      replaceExisting: true,
      rules: { cashThresholdPct: 20, offlineMinutes: 30 },
    });
    await importSwitchContent(client, {
      filename: 'fault-other.csv',
      content: feedCsv(atm, { date: today, fault: 'communication' }),
      replaceExisting: true,
      rules: { cashThresholdPct: 20, offlineMinutes: 30 },
    });
    const tickets = await client.query(
      `SELECT fault_code FROM fault_tickets
       WHERE atm_id = $1 AND source = 'monitor' AND status <> 'closed'
       ORDER BY fault_code`,
      [atm.atmId]
    );
    assert.deepEqual(tickets.rows.map((row) => row.fault_code), ['communication', 'hardware']);

    await importSwitchContent(client, {
      filename: 'off.csv',
      content: feedCsv(atm, { date: today, online: '0' }),
      replaceExisting: true,
      rules: { offlineMinutes: 30 },
    });
    const early = await client.query(
      `SELECT COUNT(*)::int AS n FROM downtime_log WHERE atm_id = $1`,
      [atm.atmId]
    );
    assert.equal(early.rows[0].n, 0);
    await client.query(
      `UPDATE atm_link_status
       SET offline_since = CURRENT_TIMESTAMP - interval '10 minutes'
       WHERE atm_id = $1`,
      [atm.atmId]
    );
    await importSwitchContent(client, {
      filename: 'off-long.csv',
      content: feedCsv(atm, { date: today, online: '0' }),
      replaceExisting: true,
      rules: { offlineMinutes: 2 },
    });
    await importSwitchContent(client, {
      filename: 'off-still.csv',
      content: feedCsv(atm, { date: today, online: '0' }),
      replaceExisting: true,
      rules: { offlineMinutes: 2 },
    });
    const openDown = await client.query(
      `SELECT COUNT(*)::int AS n FROM downtime_log WHERE atm_id = $1 AND ended_at IS NULL`,
      [atm.atmId]
    );
    assert.equal(openDown.rows[0].n, 1);
    await client.query(
      `INSERT INTO downtime_log (atm_id, started_at, reason, notes, origin)
       VALUES ($1, CURRENT_TIMESTAMP - interval '2 hours', 'hardware', 'keep this note', NULL)`,
      [atm.atmId]
    );
    await client.query(
      `INSERT INTO downtime_log (atm_id, started_at, reason, notes, origin)
       VALUES ($1, CURRENT_TIMESTAMP - interval '30 minutes', 'communication', 'feed still open', 'live_feed')`,
      [atm.atmId]
    );
    await importSwitchContent(client, {
      filename: 'on.csv',
      content: feedCsv(atm, { date: today, online: '1' }),
      replaceExisting: true,
      rules: { offlineMinutes: 2 },
    });
    const stillOpen = await client.query(
      `SELECT reason, notes, origin FROM downtime_log WHERE atm_id = $1 AND ended_at IS NULL ORDER BY reason`,
      [atm.atmId]
    );
    assert.deepEqual(stillOpen.rows.map((row) => row.reason), ['hardware']);
    assert.equal(stillOpen.rows[0].notes, 'keep this note');
    await closeLiveFeedDowntime(client);
    const afterClose = await client.query(
      `SELECT COUNT(*)::int AS n FROM downtime_log WHERE atm_id = $1 AND ended_at IS NULL AND origin = 'live_feed'`,
      [atm.atmId]
    );
    assert.equal(afterClose.rows[0].n, 0);
    const hardwareLeft = await client.query(
      `SELECT notes FROM downtime_log WHERE atm_id = $1 AND reason = 'hardware' AND ended_at IS NULL`,
      [atm.atmId]
    );
    assert.equal(hardwareLeft.rows[0].notes, 'keep this note');
  });
});

test('the same inbound checksum is not loaded twice', async () => {
  await withRollback(async (client) => {
    const atm = await makeAtm(client);
    const content = `atm_code,txn_date,amount,txn_count\n${atm.atmCode},2024-08-11,2500,4\n`;
    const first = await ingestTracked(client, { filename: 'once.csv', content, source: 'schedule' });
    const second = await ingestTracked(client, { filename: 'once-copy.csv', content, source: 'schedule' });
    assert.equal(first.duplicate, false);
    assert.equal(first.loaded, 1);
    assert.equal(second.duplicate, true);
    assert.equal(second.batchId, first.batchId);
    const rows = await client.query(
      'SELECT COUNT(*)::int AS n FROM daily_withdrawals WHERE atm_id = $1 AND withdrawal_date = DATE \'2024-08-11\'',
      [atm.atmId]
    );
    assert.equal(rows.rows[0].n, 1);
  });
});

test('a simulator tick posts through the switch pipeline', async () => {
  await withRollback(async (client) => {
    const atm = await makeAtm(client, { capacity: 200000, cash: 100000 });
    const result = await runSimulatorTick(client, {
      atmIds: [atm.atmId],
      rng: () => 0.5,
      rules: { cashThresholdPct: 20, offlineMinutes: 30 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'simulator');
    const named = await client.query('SELECT filename FROM switch_import_batches WHERE batch_id = $1', [result.batchId]);
    assert.match(named.rows[0].filename, /^switch-feed-/);
    assert.equal(result.loaded, 1);
    const cash = await client.query('SELECT current_cash FROM atms WHERE atm_id = $1', [atm.atmId]);
    assert.ok(Number(cash.rows[0].current_cash) < 100000);
    const batch = await client.query('SELECT source FROM switch_import_batches WHERE batch_id = $1', [result.batchId]);
    assert.equal(batch.rows[0].source, 'simulator');
  });
});

test('the inbound folder parks a new file and a repeat, and rejects an empty file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-switch-'));
  const dirs = {
    inboundDir: path.join(root, 'in'),
    processedDir: path.join(root, 'ok'),
    rejectedDir: path.join(root, 'bad'),
  };
  fs.mkdirSync(dirs.inboundDir);
  const client = await pool.connect();
  let atm;
  const names = [`drop-${Date.now()}.csv`, `empty-${Date.now()}.csv`];
  try {
    await client.query('BEGIN');
    atm = await makeAtm(client, { capacity: 100000, cash: 50000 });
    await client.query('COMMIT');
    const body = `atm_code,txn_date,amount,txn_count\n${atm.atmCode},2024-08-12,800,2\n`;
    fs.writeFileSync(path.join(dirs.inboundDir, names[0]), body);
    const first = await scanInboundOnce(dirs);
    assert.equal(first[0].bucket, 'processed');
    assert.equal(fs.readdirSync(dirs.inboundDir).length, 0);
    fs.writeFileSync(path.join(dirs.inboundDir, names[0]), body);
    const second = await scanInboundOnce(dirs);
    assert.equal(second[0].duplicate, true);
    assert.equal(second[0].bucket, 'processed');
    fs.writeFileSync(path.join(dirs.inboundDir, names[1]), '');
    const third = await scanInboundOnce(dirs);
    assert.equal(third[0].bucket, 'rejected');
    assert.ok(fs.readdirSync(dirs.rejectedDir).some((name) => name.startsWith(names[1].replace('.csv', ''))));
    const posted = await pool.query(
      `SELECT COUNT(*)::int AS n FROM daily_withdrawals WHERE atm_id = $1 AND withdrawal_date = DATE '2024-08-12'`,
      [atm.atmId]
    );
    assert.equal(posted.rows[0].n, 1);
  } finally {
    if (atm) {
      await pool.query('DELETE FROM replenishment_requests WHERE atm_id = $1', [atm.atmId]);
      await pool.query('DELETE FROM atm_link_status WHERE atm_id = $1', [atm.atmId]);
      await pool.query('DELETE FROM downtime_log WHERE atm_id = $1', [atm.atmId]);
      await pool.query('DELETE FROM fault_tickets WHERE atm_id = $1', [atm.atmId]);
      await pool.query('DELETE FROM daily_withdrawals WHERE atm_id = $1', [atm.atmId]);
      await pool.query('DELETE FROM inbound_files WHERE filename = ANY($1::text[])', [names]);
      await pool.query('DELETE FROM switch_import_batches WHERE filename = ANY($1::text[])', [names]);
      await pool.query('DELETE FROM atms WHERE atm_id = $1', [atm.atmId]);
      await pool.query('DELETE FROM branches WHERE branch_id = $1', [atm.branchId]);
      await pool.query('DELETE FROM locations WHERE location_id = $1', [atm.locationId]);
    }
    client.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pages no longer describe the ledger as synthetic and imports are linked', async () => {
  const home = await fetch(`${base}/`);
  const homeHtml = await home.text();
  assert.equal(home.status, 200);
  assert.match(homeHtml, />Live feed</);
  assert.doesNotMatch(homeHtml, /simulator/i);
  assert.match(homeHtml, /Cash alerts/);
  assert.match(homeHtml, /href="\/imports"/);
  assert.doesNotMatch(homeHtml, /synthetic|Demo data|sample data|fake data/i);
  const imports = await fetch(`${base}/imports`);
  assert.equal(imports.status, 200);
  const importsHtml = await imports.text();
  assert.match(importsHtml, /Received \(IST\)/);
  assert.doesNotMatch(importsHtml, /synthetic|Demo data|sample data/i);
});
