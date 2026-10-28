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

async function applyIngestionRules(client, rows, options = {}) {
  const settings = ruleOptions(options);
  const loaded = rows.filter((row) => row && row.loaded && row.atmId);
  for (const row of loaded) {
    if (row.cashLevel != null) await applyCashLevel(client, row, settings);
    if (row.faultCode && row.faultCode !== 'offline') await applyFault(client, row);
    if (row.online === true || row.online === false) await applyLink(client, row, settings);
  }
  return settings;
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
       (atm_id, title, description, category, priority, status, source, fault_code)
     VALUES ($1, $2, $3, $4, $5, 'open', 'monitor', $6)`,
    [
      row.atmId,
      `${row.faultCode.replace(/_/g, ' ')} at ${row.atmCode}`,
      `Raised from switch batch ${row.batchId || ''}`.trim(),
      spec.category,
      spec.priority,
      row.faultCode,
    ]
  );
}

async function applyLink(client, row, settings) {
  const state = await client.query(
    'SELECT online, offline_since FROM atm_link_status WHERE atm_id = $1',
    [row.atmId]
  );
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
       WHERE atm_id = $1 AND ended_at IS NULL`,
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
  const open = await client.query(
    `SELECT downtime_id FROM downtime_log WHERE atm_id = $1 AND ended_at IS NULL LIMIT 1`,
    [row.atmId]
  );
  if (open.rowCount) {
    await client.query(
      `UPDATE downtime_log
       SET notes = $2
       WHERE downtime_id = $1`,
      [open.rows[0].downtime_id, `Still offline. Switch batch ${row.batchId || ''}.`.trim()]
    );
    return;
  }
  await client.query(
    `INSERT INTO downtime_log (atm_id, started_at, reason, notes)
     VALUES ($1, $2, $3, $4)`,
    [row.atmId, offlineSince, reason, `Offline from switch batch ${row.batchId || ''}.`.trim()]
  );
}

module.exports = {
  TICKET_FAULTS,
  ruleOptions,
  applyIngestionRules,
};
