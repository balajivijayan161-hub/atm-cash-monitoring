const { titleCase } = require('../http');

const TICKET_FAULTS = {
  cash_out: { category: 'cash_out', priority: 'high', downtime: 'cash_out' },
  hardware: { category: 'hardware', priority: 'medium', downtime: 'hardware' },
  communication: { category: 'communication', priority: 'medium', downtime: 'communication' },
  cassette_error: { category: 'cassette_error', priority: 'high', downtime: 'cassette_error' },
  power: { category: 'hardware', priority: 'high', downtime: 'power' },
  vandalism: { category: 'hardware', priority: 'high', downtime: 'vandalism' },
};

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function ruleOptions(overrides = {}) {
  return {
    cashThresholdPct: overrides.cashThresholdPct ?? envNumber('CASH_ALERT_PCT', 20),
    offlineMinutes: overrides.offlineMinutes ?? envNumber('OFFLINE_MINUTES', 2),
  };
}

function endOfIstDayMs(txnDate) {
  const day = String(txnDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T23:59:59.999+05:30`);
  return Number.isNaN(ms) ? null : ms;
}

function stateMillis(stateAsOf) {
  if (stateAsOf instanceof Date) return stateAsOf.getTime();
  const text = String(stateAsOf).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T00:00:00+05:30`);
  const parsed = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : parsed;
}

function rowUpdatesCurrentState(txnDate, stateAsOf) {
  const eventMs = endOfIstDayMs(txnDate);
  if (eventMs == null) return false;
  if (stateAsOf == null || stateAsOf === '') return true;
  const stateMs = stateMillis(stateAsOf);
  if (stateMs == null) return true;
  return eventMs >= stateMs;
}

function downtimeOrigin(batchSource) {
  return batchSource === 'simulator' ? 'live_feed' : 'switch';
}

async function applyIngestionRules(client, rows, options = {}) {
  const settings = ruleOptions(options);
  const loaded = rows.filter((row) => row && row.loaded && row.atmId);
  const ordered = [...loaded].sort((a, b) => {
    const byDate = String(a.txnDate || '').localeCompare(String(b.txnDate || ''));
    if (byDate) return byDate;
    return (a.lineNo || 0) - (b.lineNo || 0);
  });
  const stateAsOf = new Map();
  const ids = [...new Set(ordered.map((row) => row.atmId))];
  if (ids.length) {
    const known = await client.query(
      'SELECT atm_id, state_as_of FROM atm_link_status WHERE atm_id = ANY($1::int[])',
      [ids]
    );
    for (const row of known.rows) stateAsOf.set(row.atm_id, row.state_as_of);
  }
  for (const row of ordered) {
    const hasState = row.cashLevel != null || (row.faultCode && row.faultCode !== 'offline') || row.online === true || row.online === false;
    if (!hasState) continue;
    if (!rowUpdatesCurrentState(row.txnDate, stateAsOf.get(row.atmId) || null)) continue;
    if (row.cashLevel != null) await applyCashLevel(client, row, settings);
    if (row.faultCode && row.faultCode !== 'offline') await applyFault(client, row);
    if (row.online === true || row.online === false) await applyLink(client, row, settings);
    const saved = await client.query(
      `INSERT INTO atm_link_status (atm_id, online, state_as_of)
       VALUES ($1, TRUE, ($2::date + time '23:59:59.999') AT TIME ZONE 'Asia/Kolkata')
       ON CONFLICT (atm_id) DO UPDATE
         SET state_as_of = EXCLUDED.state_as_of, updated_at = CURRENT_TIMESTAMP
       RETURNING state_as_of`,
      [row.atmId, row.txnDate]
    );
    stateAsOf.set(row.atmId, saved.rows[0].state_as_of);
  }
  return settings;
}

async function closeLiveFeedDowntime(client) {
  await client.query(
    `UPDATE downtime_log
     SET ended_at = CURRENT_TIMESTAMP
     WHERE ended_at IS NULL AND origin = 'live_feed'`
  );
  await client.query(
    `UPDATE fault_tickets
     SET status = 'closed',
         closed_at = CURRENT_TIMESTAMP,
         resolution = 'Feed stopped'
     WHERE status <> 'closed' AND origin = 'live_feed'`
  );
}

async function applyCashLevel(client, row, settings) {
  await client.query(
    'UPDATE atms SET current_cash = $2 WHERE atm_id = $1',
    [row.atmId, row.cashLevel]
  );
  const pct = (Number(row.cashLevel) / Number(row.capacity)) * 100;
  if (pct < settings.cashThresholdPct) {
    const open = await client.query(
      `UPDATE replenishment_requests
       SET current_cash = $2, capacity_amount = $3, threshold_pct = $4, batch_id = $5
       WHERE atm_id = $1 AND status = 'open'`,
      [row.atmId, row.cashLevel, row.capacity, settings.cashThresholdPct, row.batchId || null]
    );
    if (!open.rowCount) {
      await client.query(
        `INSERT INTO replenishment_requests
           (atm_id, batch_id, current_cash, capacity_amount, threshold_pct)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.atmId, row.batchId || null, row.cashLevel, row.capacity, settings.cashThresholdPct]
      );
    }
  } else {
    await client.query(
      `UPDATE replenishment_requests
       SET status = 'closed', closed_at = CURRENT_TIMESTAMP
       WHERE atm_id = $1 AND status = 'open'`,
      [row.atmId]
    );
  }
}

async function applyFault(client, row) {
  const spec = TICKET_FAULTS[row.faultCode];
  if (!spec) return;
  const existing = await client.query(
    `SELECT ticket_id FROM fault_tickets
     WHERE atm_id = $1 AND fault_code = $2 AND status <> 'closed'
     LIMIT 1`,
    [row.atmId, row.faultCode]
  );
  if (existing.rowCount) return;
  await client.query(
    `INSERT INTO fault_tickets
       (atm_id, title, description, category, priority, status, source, fault_code, origin)
     VALUES ($1, $2, $3, $4, $5, 'open', 'monitor', $6, $7)`,
    [
      row.atmId,
      `${titleCase(row.faultCode)} at ${row.atmCode}`,
      'Raised from bank data.',
      spec.category,
      spec.priority,
      row.faultCode,
      downtimeOrigin(row.batchSource),
    ]
  );
}

async function applyLink(client, row, settings) {
  const state = await client.query(
    'SELECT online, offline_since FROM atm_link_status WHERE atm_id = $1',
    [row.atmId]
  );
  const origin = downtimeOrigin(row.batchSource);
  if (row.online) {
    if (state.rowCount) {
      await client.query(
        `UPDATE atm_link_status
         SET online = TRUE, offline_since = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE atm_id = $1`,
        [row.atmId]
      );
    }
    await client.query(
      `UPDATE downtime_log
       SET ended_at = CURRENT_TIMESTAMP
       WHERE atm_id = $1 AND ended_at IS NULL AND origin IN ('live_feed', 'switch')`,
      [row.atmId]
    );
    return;
  }

  let offlineSince = state.rows[0]?.offline_since || null;
  if (!state.rowCount) {
    const inserted = await client.query(
      `INSERT INTO atm_link_status (atm_id, online, offline_since)
       VALUES ($1, FALSE, CURRENT_TIMESTAMP)
       RETURNING offline_since`,
      [row.atmId]
    );
    offlineSince = inserted.rows[0].offline_since;
  } else if (state.rows[0].online || !offlineSince) {
    const updated = await client.query(
      `UPDATE atm_link_status
       SET online = FALSE, offline_since = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE atm_id = $1
       RETURNING offline_since`,
      [row.atmId]
    );
    offlineSince = updated.rows[0].offline_since;
  } else {
    await client.query(
      'UPDATE atm_link_status SET updated_at = CURRENT_TIMESTAMP WHERE atm_id = $1',
      [row.atmId]
    );
  }

  const elapsed = await client.query(
    `SELECT EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - $1::timestamptz)) / 60.0 AS minutes`,
    [offlineSince]
  );
  const minutes = Number(elapsed.rows[0].minutes);
  if (minutes < settings.offlineMinutes) return;

  const reason = (TICKET_FAULTS[row.faultCode] && TICKET_FAULTS[row.faultCode].downtime) || 'communication';
  const openRows = await client.query(
    `SELECT downtime_id, origin FROM downtime_log
     WHERE atm_id = $1 AND ended_at IS NULL
     ORDER BY started_at, downtime_id`,
    [row.atmId]
  );
  const own = openRows.rows.find((item) => item.origin === origin);
  if (own) {
    await client.query(
      `UPDATE downtime_log
       SET notes = $2
       WHERE downtime_id = $1`,
      [own.downtime_id, 'Still offline.']
    );
    return;
  }
  if (openRows.rowCount) return;
  await client.query(
    `INSERT INTO downtime_log (atm_id, started_at, reason, notes, origin)
     VALUES ($1, $2, $3, $4, $5)`,
    [row.atmId, offlineSince, reason, 'Opened while the ATM was offline.', origin]
  );
}

module.exports = {
  TICKET_FAULTS,
  ruleOptions,
  rowUpdatesCurrentState,
  downtimeOrigin,
  applyIngestionRules,
  closeLiveFeedDowntime,
};
