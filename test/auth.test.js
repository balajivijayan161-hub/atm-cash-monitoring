const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { hoursToEmpty, runsOutWithinDay } = require('../src/services/cashout');
const { can } = require('../src/auth/permissions');
const { ensureUsers, pool, createAgent } = require('./helpers');

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

test('hours to empty follow the next-day forecast', () => {
  assert.equal(hoursToEmpty(120000, 240000), 12);
  assert.equal(hoursToEmpty(0, 1000), 0);
  assert.equal(hoursToEmpty(5000, 0), null);
  assert.equal(runsOutWithinDay(24), true);
  assert.equal(runsOutWithinDay(24.1), false);
  assert.equal(can({ role: 'clerk', active: true }, 'approveRuns'), false);
  assert.equal(can({ role: 'regional_manager', active: true }, 'approveRuns'), true);
  assert.equal(can({ role: 'engineer', active: true }, 'importData'), false);
  assert.equal(can({ role: 'super_admin', active: true }, 'manageUsers'), true);
});

test('sign-in, role limits, and append-only activity', async () => {
  const admin = createAgent(base);
  const signed = await admin.login();
  assert.equal(signed.status, 302);
  const home = await admin.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Log Out/);
  const users = await admin.get('/users');
  assert.equal(users.status, 200);
  const activity = await admin.get('/activity');
  assert.equal(activity.status, 200);
  assert.match(activity.text, /IST/);

  const clerk = createAgent(base);
  const clerkIn = await clerk.login('clerk', process.env.DEMO_PASSWORD);
  assert.equal(clerkIn.status, 302);
  const denied = await clerk.get('/users');
  assert.equal(denied.status, 403);
  const bad = createAgent(base);
  await bad.get('/login');
  const failed = await bad.post('/login', { username: 'superadmin', password: 'wrong-password' });
  assert.equal(failed.status, 401);
  assert.match(failed.text, /Invalid username or password/);

  await assert.rejects(
    pool.query(`UPDATE session_log SET username = 'changed' WHERE session_log_id = (SELECT MIN(session_log_id) FROM session_log)`),
    /append-only/
  );
});
