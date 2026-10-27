const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { types } = require('pg');
types.setTypeParser(1082, (value) => value);
types.setTypeParser(1700, (value) => Number(value));
types.setTypeParser(20, (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value;
});

function shouldUseSsl(connectionString) {
  if (!connectionString) return false;
  if (process.env.PGSSLMODE === 'disable') return false;
  if (/[?&]sslmode=disable(?:&|$)/.test(connectionString)) return false;
  if (/localhost|127\.0\.0\.1/.test(connectionString)) return false;
  return { rejectUnauthorized: false };
}

function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is required. Example: postgres://atm_ops:atm_ops@127.0.0.1:5432/atm_cash'
    );
  }
  return new Pool({
    connectionString,
    ssl: shouldUseSsl(connectionString),
    max: 8,
    idleTimeoutMillis: 10000,
    allowExitOnIdle: true,
    application_name: 'atm-cash-ops',
    options: '-c TimeZone=Asia/Kolkata',
  });
}

const pool = createPool();

pool.on('error', (err) => {
  console.error('Unexpected database pool error', err);
});

const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');

function formatSqlError(sql, err) {
  if (!err.position) return err.message;
  const pos = Number(err.position);
  const start = Math.max(0, pos - 120);
  return `${err.message}\nNear: ${sql.slice(start, pos + 120)}`;
}

async function applySchema(client) {
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const runner = client || pool;
  try {
    await runner.query(sql);
  } catch (err) {
    err.message = formatSqlError(sql, err);
    throw err;
  }
}

async function ensureSchema() {
  await applySchema();
}

async function query(text, params) {
  return pool.query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  applySchema,
  ensureSchema,
  withTransaction,
};
