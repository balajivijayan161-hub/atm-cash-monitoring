const { pool, ensureSchema } = require('../src/db');

let sequence = 0;

function token(prefix) {
  sequence += 1;
  return `${prefix}${sequence.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, 'X')
    .slice(0, 10);
}

async function withRollback(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    try { await client.query('ROLLBACK'); } catch (err) { /* connection already closed */ }
    client.release();
  }
}

async function makeAtm(client, { code, cash = 100000, capacity = 2000000, status = 'active' } = {}) {
  const locationCode = token('L');
  const location = await client.query(
    `INSERT INTO locations (location_code, location_name, city, state, region)
     VALUES ($1, 'Test City', 'Test', 'TS', 'South')
     RETURNING location_id`,
    [locationCode]
  );
  const branch = await client.query(
    `INSERT INTO branches (location_id, branch_code, branch_name, address, ifsc_code)
     VALUES ($1, $2, 'Test Branch', '1 Test Road', $3)
     RETURNING branch_id`,
    [location.rows[0].location_id, token('B'), token('F').padEnd(11, '0').slice(0, 11)]
  );
  const atmCode = code || `ATM-${token('A')}`;
  const atm = await client.query(
    `INSERT INTO atms (
       branch_id, atm_code, site_name, address, status, installed_on,
       capacity_amount, current_cash
     ) VALUES ($1, $2, 'Test lobby', '1 Test Road', $3, DATE '2020-01-01', $4, $5)
     RETURNING atm_id`,
    [branch.rows[0].branch_id, atmCode, status, capacity, cash]
  );
  return {
    atmId: atm.rows[0].atm_id,
    atmCode,
    locationId: location.rows[0].location_id,
    branchId: branch.rows[0].branch_id,
  };
}

module.exports = { ensureSchema, withRollback, makeAtm, pool };
