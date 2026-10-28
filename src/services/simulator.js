const { withTransaction } = require('../db');
const { importSwitchContent } = require('./switchImport');

const DEFAULT_TICK_MS = 4000;
const DEFAULT_MAX_MS = 15 * 60 * 1000;

const state = {
  running: false,
  startedAt: null,
  stopsAt: null,
  ticks: 0,
  lastBatchId: null,
  timer: null,
  offline: new Set(),
};

function limits() {
  const tickMs = Number(process.env.SIMULATOR_TICK_MS);
  const maxMs = Number(process.env.SIMULATOR_MAX_MS);
  return {
    tickMs: Number.isFinite(tickMs) && tickMs > 0 ? tickMs : DEFAULT_TICK_MS,
    maxMs: Number.isFinite(maxMs) && maxMs > 0 ? maxMs : DEFAULT_MAX_MS,
  };
}

function getSimulatorStatus() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    stopsAt: state.stopsAt,
    ticks: state.ticks,
    lastBatchId: state.lastBatchId,
  };
}

function shouldAutoStop(startedAt, now, maxMs) {
  if (!startedAt) return false;
  return now - startedAt >= maxMs;
}

async function runSimulatorTick(client, options = {}) {
  const rng = options.rng || Math.random;
  const todayRes = await client.query('SELECT CURRENT_DATE::text AS today');
  const today = todayRes.rows[0].today;
  const atms = options.atmIds
    ? (await client.query(
      `SELECT atm_id, atm_code, current_cash, capacity_amount
       FROM atms WHERE atm_id = ANY($1::int[]) ORDER BY atm_id`,
      [options.atmIds]
    )).rows
    : (await client.query(
      `SELECT atm_id, atm_code, current_cash, capacity_amount
       FROM atms
       WHERE status IN ('active', 'cash_out')
       ORDER BY random()
       LIMIT 6`
    )).rows;
  if (!atms.length) return { ok: false, fileError: 'No ATMs are available for the live feed.' };

  const ids = atms.map((row) => row.atm_id);
  const posted = await client.query(
    `SELECT atm_id, amount, txn_count
     FROM daily_withdrawals
     WHERE withdrawal_date = $1::date AND atm_id = ANY($2::int[])`,
    [today, ids]
  );
  const byAtm = new Map(posted.rows.map((row) => [row.atm_id, row]));
  const lines = ['atm_code,txn_date,amount,txn_count,cash_level,fault_code,online'];
  const offline = options.offline || state.offline;

  for (const atm of atms) {
    const roll = rng();
    let fault = '';
    if (roll < 0.04) fault = 'hardware';
    else if (roll < 0.07) fault = 'cassette_error';
    else if (roll < 0.1) fault = 'communication';
    else if (roll < 0.13) fault = 'cash_out';

    if (offline.has(atm.atm_id)) {
      if (rng() < 0.35) offline.delete(atm.atm_id);
    } else if (rng() < 0.08) {
      offline.add(atm.atm_id);
    }
    const online = offline.has(atm.atm_id) ? '0' : '1';

    const previous = byAtm.get(atm.atm_id);
    const delta = 800 + Math.round(rng() * 4200);
    const amount = Number(previous ? previous.amount : 0) + delta;
    const txnCount = Number(previous ? previous.txn_count : 0) + 1 + Math.round(rng() * 4);
    const cash = Math.max(0, Math.round((Number(atm.current_cash) - delta) * 100) / 100);
    lines.push([
      atm.atm_code,
      today,
      amount.toFixed(2),
      String(txnCount),
      cash.toFixed(2),
      fault,
      online,
    ].join(','));
  }

  const content = `${lines.join('\n')}\n`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return importSwitchContent(client, {
    filename: `simulator-${stamp}.csv`,
    content,
    replaceExisting: true,
    source: 'simulator',
    rules: options.rules,
  });
}

async function tickSimulator() {
  const { maxMs } = limits();
  if (!state.running) return;
  if (shouldAutoStop(state.startedAt, Date.now(), maxMs)) {
    stopSimulator();
    return;
  }
  try {
    const result = await withTransaction((client) => runSimulatorTick(client));
    state.ticks += 1;
    if (result && result.batchId) state.lastBatchId = result.batchId;
  } catch (err) {
    console.error('Live feed tick failed', err);
  }
}

function startSimulator() {
  if (state.running) return getSimulatorStatus();
  const { tickMs, maxMs } = limits();
  const now = Date.now();
  state.running = true;
  state.startedAt = now;
  state.stopsAt = now + maxMs;
  state.timer = setInterval(tickSimulator, tickMs);
  if (typeof state.timer.unref === 'function') state.timer.unref();
  tickSimulator();
  return getSimulatorStatus();
}

function stopSimulator() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.running = false;
  state.stopsAt = null;
  return getSimulatorStatus();
}

module.exports = {
  getSimulatorStatus,
  shouldAutoStop,
  runSimulatorTick,
  startSimulator,
  stopSimulator,
};
