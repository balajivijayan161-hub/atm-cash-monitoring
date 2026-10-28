const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { seedAccessUsers } = require('../src/auth/accounts');
const { inr } = require('../src/http');
const { ensureUsers, withRollback, pool, createAgent } = require('./helpers');

let server;
let base;

before(async () => {
  await ensureUsers();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function signed(username, password = process.env.DEMO_PASSWORD) {
  const agent = createAgent(base);
  const response = await agent.login(username, username === 'superadmin' ? process.env.ADMIN_PASSWORD : password);
  assert.equal(response.status, 302, `${username} ${response.status} ${response.text.slice(0, 120)}`);
  return agent;
}

test('indian currency groups by lakhs', () => {
  assert.match(inr(1272400), /12,72,400/);
});

test('each role reaches its own pages and unknown addresses are not found', async () => {
  const custodian = await signed('custodian');
  assert.equal((await custodian.get('/runs')).status, 200);
  assert.equal((await custodian.get('/forecast')).status, 403);
  assert.equal((await custodian.get('/no-such-page')).status, 404);

  const clerk = await signed('clerk');
  assert.equal((await clerk.get('/alerts')).status, 200);
  assert.equal((await clerk.get('/downtime')).status, 200);
  assert.equal((await clerk.get('/users')).status, 403);
  assert.equal((await clerk.get('/missing-page')).status, 404);

  const branch = await signed('branch.manager');
  assert.equal((await branch.get('/alerts')).status, 200);
  assert.equal((await branch.get('/downtime')).status, 200);
  assert.equal((await branch.get('/activity')).status, 403);

  const regional = await signed('regional.manager');
  assert.equal((await regional.get('/activity')).status, 200);
  assert.equal((await regional.get('/users')).status, 403);

  const engineer = await signed('engineer');
  assert.equal((await engineer.get('/tickets')).status, 200);
  assert.equal((await engineer.get('/runs')).status, 403);

  const admin = await signed('superadmin');
  assert.equal((await admin.get('/users')).status, 200);
  assert.equal((await admin.get('/not-a-real-page')).status, 404);
  assert.equal((await admin.get('/')).status, 200);
});

test('boot seeding does not replace a password that is already set', async () => {
  await withRollback(async (client) => {
    const before = await client.query(`SELECT password_hash, role, active, failed_attempts FROM users WHERE username = 'clerk'`);
    const saved = process.env.DEMO_PASSWORD;
    process.env.DEMO_PASSWORD = 'another-demo-password';
    try {
      await seedAccessUsers(client);
      const after = await client.query(`SELECT password_hash, role, active, failed_attempts FROM users WHERE username = 'clerk'`);
      assert.deepEqual(after.rows, before.rows);
      await client.query(`UPDATE users SET password_hash = NULL, failed_attempts = 3 WHERE username = 'engineer'`);
      await seedAccessUsers(client);
      const engineer = await client.query(`SELECT password_hash IS NULL AS blank, failed_attempts FROM users WHERE username = 'engineer'`);
      assert.equal(engineer.rows[0].blank, false);
      assert.equal(engineer.rows[0].failed_attempts, 3);
    } finally {
      process.env.DEMO_PASSWORD = saved;
    }
  });
});

test('a variance case can move from raised to investigating', async () => {
  await withRollback(async (client) => {
    const atm = await client.query(`SELECT atm_id FROM atms ORDER BY atm_id LIMIT 1`);
    const inserted = await client.query(
      `INSERT INTO reconciliations (atm_id, recon_date, expected_amount, counted_amount, case_status)
       VALUES ($1, CURRENT_DATE, 100, 90, 'raised')
       RETURNING reconciliation_id`,
      [atm.rows[0].atm_id]
    );
    await client.query(
      `UPDATE reconciliations
       SET case_status = $2::varchar,
           reason_code = CASE WHEN $3::boolean THEN NULLIF($4, '')::varchar ELSE reason_code END,
           assignee_id = COALESCE($5::int, assignee_id),
           closed_by = CASE WHEN $3::boolean THEN $6::int ELSE closed_by END,
           closed_at = CASE WHEN $3::boolean THEN CURRENT_TIMESTAMP ELSE closed_at END
       WHERE reconciliation_id = $1`,
      [inserted.rows[0].reconciliation_id, 'investigating', false, '', null, 1]
    );
    const row = await client.query(
      `SELECT case_status FROM reconciliations WHERE reconciliation_id = $1`,
      [inserted.rows[0].reconciliation_id]
    );
    assert.equal(row.rows[0].case_status, 'investigating');
  });
});

test('truncating an activity log is rejected', async () => {
  await assert.rejects(pool.query('TRUNCATE session_log'), /append-only/);
});
