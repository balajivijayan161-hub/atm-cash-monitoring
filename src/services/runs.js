const { normalizeLoads } = require('../lib/loads');
const { isIsoDate, intOrNull, inr } = require('../http');

const RUN_STATUSES = new Set(['planned', 'in_progress', 'completed', 'cancelled']);

async function saveRun(client, body, runId = null) {
  const errors = [];
  const locationId = intOrNull(body.location_id);
  const vanId = intOrNull(body.van_id);
  const custodianId = intOrNull(body.custodian_id);
  const plannedDate = typeof body.planned_date === 'string' ? body.planned_date : '';
  const status = body.status;
  const notes = String(body.notes || '').trim().slice(0, 2000);

  if (!isIsoDate(plannedDate)) errors.push('Choose a valid run date.');
  if (!locationId) errors.push('Choose a location.');
  if (!vanId) errors.push('Choose a cash van.');
  if (!custodianId) errors.push('Choose a custodian.');
  if (!RUN_STATUSES.has(status)) errors.push('Choose a run status.');

  const normalized = normalizeLoads(body);
  errors.push(...normalized.errors);

  if (vanId && locationId) {
    const vanRes = await client.query(
      'SELECT van_id, location_id, status FROM cash_vans WHERE van_id = $1',
      [vanId]
    );
    if (!vanRes.rowCount) errors.push('That cash van was not found.');
    else if (vanRes.rows[0].status === 'maintenance') errors.push('That cash van is in maintenance.');
    else if (vanRes.rows[0].location_id !== locationId) errors.push('The van is based in a different location.');
  }

  if (custodianId) {
    const custodianRes = await client.query(
      'SELECT custodian_id, van_id, active FROM custodians WHERE custodian_id = $1',
      [custodianId]
    );
    const custodian = custodianRes.rows[0];
    if (!custodian || !custodian.active) errors.push('Choose an active custodian.');
    else if (vanId && custodian.van_id !== vanId) errors.push('That custodian is not assigned to this van.');
  }

  const codes = [...new Set(normalized.lines.map((line) => line.atmCode).filter(Boolean))];
  const atmMap = new Map();
  if (codes.length) {
    const atms = await client.query(
      `SELECT a.atm_id, a.atm_code, b.location_id
       FROM atms a
       JOIN branches b ON b.branch_id = a.branch_id
       WHERE a.atm_code = ANY($1::text[])`,
      [codes]
    );
    for (const atm of atms.rows) atmMap.set(atm.atm_code, atm);
  }
  for (const line of normalized.lines) {
    if (!line.amount) continue;
    const atm = atmMap.get(line.atmCode);
    if (!atm) errors.push(`${line.atmCode} is not a known ATM.`);
    else if (locationId && atm.location_id !== locationId) errors.push(`${line.atmCode} is not in the selected location.`);
    else line.atmId = atm.atm_id;
  }

  const loadByAtm = new Map();
  for (const line of normalized.lines) {
    if (!line.atmId || !line.amount) continue;
    const next = (loadByAtm.get(line.atmId) || 0) + line.amount;
    loadByAtm.set(line.atmId, Math.round(next * 100) / 100);
  }
  if (loadByAtm.size) {
    const atmIds = [...loadByAtm.keys()];
    const caps = await client.query(
      'SELECT atm_id, atm_code, capacity_amount, current_cash FROM atms WHERE atm_id = ANY($1::int[])',
      [atmIds]
    );
    for (const atm of caps.rows) {
      const capacity = Number(atm.capacity_amount);
      const room = Math.round((capacity - Number(atm.current_cash)) * 100) / 100;
      if (loadByAtm.get(atm.atm_id) > room) {
        errors.push(`${atm.atm_code}: load exceeds remaining ATM capacity (${inr(room)} still available of ${inr(capacity)}).`);
      }
    }
    if (isIsoDate(plannedDate) && status !== 'cancelled') {
      const dupes = await client.query(
        `SELECT DISTINCT a.atm_code, rr.run_id
         FROM cassette_loads cl
         JOIN replenishment_runs rr ON rr.run_id = cl.run_id
         JOIN atms a ON a.atm_id = cl.atm_id
         WHERE cl.atm_id = ANY($1::int[])
           AND rr.planned_date = $2::date
           AND rr.status <> 'cancelled'
           AND ($3::int IS NULL OR rr.run_id <> $3)
         ORDER BY a.atm_code, rr.run_id`,
        [atmIds, plannedDate, runId]
      );
      for (const row of dupes.rows) {
        errors.push(`${row.atm_code} is already on run ${row.run_id} for ${plannedDate}.`);
      }
    }
  }

  const form = {
    location_id: locationId || '',
    van_id: vanId || '',
    custodian_id: custodianId || '',
    planned_date: plannedDate,
    status: RUN_STATUSES.has(status) ? status : 'planned',
    notes,
  };

  if (errors.length) {
    return { errors, form, lines: normalized.lines, total: normalized.total };
  }

  let id = runId;
  if (id) {
    const updated = await client.query(
      `UPDATE replenishment_runs
       SET van_id = $2, custodian_id = $3, location_id = $4, planned_date = $5, status = $6, notes = $7
       WHERE run_id = $1
       RETURNING run_id`,
      [id, vanId, custodianId, locationId, plannedDate, status, notes || null]
    );
    if (!updated.rowCount) {
      return { errors: ['That run no longer exists.'], form, lines: normalized.lines, total: normalized.total };
    }
    await client.query('DELETE FROM cassette_loads WHERE run_id = $1', [id]);
  } else {
    const inserted = await client.query(
      `INSERT INTO replenishment_runs
         (van_id, custodian_id, location_id, planned_date, status, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'operator')
       RETURNING run_id`,
      [vanId, custodianId, locationId, plannedDate, status, notes || null]
    );
    id = inserted.rows[0].run_id;
  }

  for (const line of normalized.lines) {
    await client.query(
      `INSERT INTO cassette_loads (run_id, atm_id, cassette_number, denomination, note_count, amount)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, line.atmId, line.cassette, line.denomination, line.noteCount, line.amount]
    );
  }

  return { runId: id, total: normalized.total };
}

module.exports = { saveRun, RUN_STATUSES };
