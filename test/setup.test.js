const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { checkPassword, secretMatch } = require('../src/auth/password');
const { seedAccessUsers } = require('../src/auth/accounts');
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
  delete process.env.SETUP_TOKEN;
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('a missing password hash cannot sign in, and secrets compare without a plain equality', async () => {
  assert.equal(await checkPassword('anything', null), false);
  assert.equal(secretMatch('same-token', 'same-token'), true);
  assert.equal(secretMatch('same-token', 'other-token'), false);
});

test('unset password env vars do not replace or invent passwords', async () => {
  await withRollback(async (client) => {
    const before = await client.query(`SELECT username, password_hash FROM users ORDER BY username`);
    const admin = process.env.ADMIN_PASSWORD;
    const demo = process.env.DEMO_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    delete process.env.DEMO_PASSWORD;
    try {
      await seedAccessUsers(client);
      const after = await client.query(`SELECT username, password_hash FROM users ORDER BY username`);
      assert.deepEqual(after.rows, before.rows);
      await client.query(`UPDATE users SET password_hash = NULL WHERE username = 'clerk'`);
      await seedAccessUsers(client);
      const clerk = await client.query(`SELECT password_hash FROM users WHERE username = 'clerk'`);
      assert.equal(clerk.rows[0].password_hash, null);
    } finally {
      process.env.ADMIN_PASSWORD = admin;
      process.env.DEMO_PASSWORD = demo;
    }
  });
});

test('first-run setup is one time, and a super admin can set another password', async () => {
  const anon = createAgent(base);
  const login = await anon.get('/login');
  assert.match(login.text, /id="username"/);
  assert.match(login.text, /name="username"/);
  assert.match(login.text, /autocomplete="username"/);
  assert.match(login.text, /id="password"/);
  assert.match(login.text, /name="password"/);
  assert.match(login.text, /autocomplete="current-password"/);

  const admin = createAgent(base);
  assert.equal((await admin.login()).status, 302);
  const users = await admin.get('/users');
  assert.equal(users.status, 200);
  assert.match(users.text, /Set Password/);
  assert.match(users.text, /autocomplete="new-password"/);
  const clerk = await pool.query(`SELECT user_id FROM users WHERE username = 'clerk'`);
  const mismatch = await admin.post(`/users/${clerk.rows[0].user_id}/password`, {
    password: 'clerk-pass-1',
    password_confirm: 'clerk-pass-2',
  });
  assert.match(mismatch.location, /do not match/);
  const saved = await admin.post(`/users/${clerk.rows[0].user_id}/password`, {
    password: 'clerk-pass-1',
    password_confirm: 'clerk-pass-1',
  });
  assert.match(saved.location, /Password saved/);
  const clerkIn = await createAgent(base).login('clerk', 'clerk-pass-1');
  assert.equal(clerkIn.status, 302);
  await seedAccessUsers();

  const original = await pool.query(`SELECT password_hash FROM users WHERE username = 'superadmin'`);
  process.env.SETUP_TOKEN = 'test-setup-token';
  try {
    const closed = await createAgent(base).get('/setup');
    assert.equal(closed.status, 404);

    await pool.query(`UPDATE users SET password_hash = NULL WHERE username = 'superadmin'`);
    delete process.env.SETUP_TOKEN;
    const disabled = await createAgent(base).get('/setup');
    assert.equal(disabled.status, 404);

    process.env.SETUP_TOKEN = 'test-setup-token';
    const setup = createAgent(base);
    const form = await setup.get('/setup');
    assert.equal(form.status, 200);
    assert.match(form.text, /at least 12 characters/);
    assert.match(form.text, /id="new-password"/);
    assert.match(form.text, /autocomplete="new-password"/);

    const badToken = await setup.post('/setup', {
      setup_token: 'wrong-token',
      password: 'Correct-Horse-1',
      password_confirm: 'Correct-Horse-1',
    });
    assert.equal(badToken.status, 401);
    assert.match(badToken.text, /does not match/);

    const short = await setup.post('/setup', {
      setup_token: 'test-setup-token',
      password: 'short-pass',
      password_confirm: 'short-pass',
    });
    assert.equal(short.status, 400);

    const mismatchSetup = await setup.post('/setup', {
      setup_token: 'test-setup-token',
      password: 'Correct-Horse-1',
      password_confirm: 'Correct-Horse-2',
    });
    assert.equal(mismatchSetup.status, 400);

    const done = await setup.post('/setup', {
      setup_token: 'test-setup-token',
      password: 'Correct-Horse-1',
      password_confirm: 'Correct-Horse-1',
    });
    assert.equal(done.status, 302);
    assert.match(done.location, /setup=done/);
    const again = await createAgent(base).get('/setup');
    assert.equal(again.status, 404);
    const signed = await createAgent(base).login('superadmin', 'Correct-Horse-1');
    assert.equal(signed.status, 302);

    const logged = await pool.query(
      `SELECT changes::text AS changes FROM change_log WHERE entity = 'first-run setup' ORDER BY change_id DESC LIMIT 5`
    );
    const blob = logged.rows.map((row) => row.changes).join('\n');
    assert.match(blob, /password set/);
    assert.match(blob, /rejected/);
    assert.doesNotMatch(blob, /test-setup-token/);
    assert.doesNotMatch(blob, /Correct-Horse-1/);
  } finally {
    await pool.query(`UPDATE users SET password_hash = $1 WHERE username = 'superadmin'`, [original.rows[0].password_hash]);
    delete process.env.SETUP_TOKEN;
    await seedAccessUsers();
  }
});
