const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { checkPassword, secretMatch } = require('../src/auth/password');
const { formText } = require('../src/http');
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
  delete process.env.ADMIN_RECOVERY;
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('a missing password hash cannot sign in, and secrets compare without a plain equality', async () => {
  assert.equal(await checkPassword('anything', null), false);
  assert.equal(secretMatch('same-token', 'same-token'), true);
  assert.equal(secretMatch('same-token', 'other-token'), false);
  assert.equal(formText({ password: '', 'new-password': 'Correct-Horse-1' }, 'new-password', 'password'), 'Correct-Horse-1');
  assert.equal(formText({ password: ['', 'Correct-Horse-1'] }, 'password'), 'Correct-Horse-1');
});

function parseForms(html) {
  return html.split(/<form\b/i).slice(1).map((part) => {
    const end = part.indexOf('>');
    const tag = `<form${part.slice(0, end + 1)}`;
    const inner = part.slice(end + 1).split(/<\/form>/i)[0];
    const attr = (name) => (tag.match(new RegExp(`${name}="([^"]*)"`, 'i')) || [])[1] || '';
    const inputs = [...inner.matchAll(/<input\b[^>]*>/gi)].map((match) => {
      const el = match[0];
      const get = (name) => (el.match(new RegExp(`\\b${name}="([^"]*)"`, 'i')) || [])[1];
      return { name: get('name'), type: (get('type') || 'text').toLowerCase(), value: get('value') || '' };
    }).filter((input) => input.name);
    return {
      action: attr('action'),
      method: (attr('method') || 'get').toLowerCase(),
      enctype: attr('enctype') || 'application/x-www-form-urlencoded',
      inputs,
    };
  });
}

function browserJar() {
  const jar = new Map();
  return {
    header() { return [...jar.values()].join('; '); },
    absorb(response) {
      const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      for (const line of lines) {
        const pair = line.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq), pair);
      }
    },
  };
}

async function submitRenderedForm(pageHtml, form, values) {
  assert.equal(form.method, 'post');
  assert.equal(form.enctype, 'application/x-www-form-urlencoded');
  assert.doesNotMatch(pageHtml, /<script\b(?![^>]*\bsrc\s*=\s*["'][^"']+["'])[^>]*>/i);
  assert.doesNotMatch(pageHtml, /\son[a-z]+\s*=/i);
  const body = new URLSearchParams();
  for (const input of form.inputs) {
    if (input.type === 'password' || /password/i.test(input.name)) body.set(input.name, values.password);
    else if (input.name === 'setup_token') body.set(input.name, values.token);
    else if (values[input.name] != null) body.set(input.name, values[input.name]);
    else body.set(input.name, input.value);
  }
  const names = form.inputs.map((input) => input.name);
  for (const name of Object.keys(values.requiredNames || {})) assert.ok(names.includes(name), name);
  return { body, names };
}

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
  await pool.query(
    `UPDATE users SET password_hash = $1 WHERE username = 'clerk'`,
    [await require('../src/auth/password').hashPassword(process.env.DEMO_PASSWORD)]
  );

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
    delete process.env.ADMIN_RECOVERY;
  }
});

test('ADMIN_RECOVERY resets an existing superadmin password and clears lockout', async () => {
  const original = await pool.query(`SELECT user_id, password_hash FROM users WHERE username = 'superadmin'`);
  const id = original.rows[0].user_id;
  const sid = `recovery-test-${id}`;
  await pool.query(
    `UPDATE users SET failed_attempts = 5, locked_until = CURRENT_TIMESTAMP + interval '30 minutes' WHERE user_id = $1`,
    [id]
  );
  await pool.query(
    `INSERT INTO session (sid, sess, expire) VALUES ($1, $2::json, CURRENT_TIMESTAMP + interval '1 hour')`,
    [sid, JSON.stringify({ user: { user_id: id } })]
  );
  process.env.SETUP_TOKEN = 'recover-token';
  process.env.ADMIN_RECOVERY = 'TRUE';
  try {
    assert.equal((await createAgent(base).get('/setup')).status, 404);
    process.env.ADMIN_RECOVERY = 'true';
    const agent = createAgent(base);
    assert.equal((await agent.get('/setup')).status, 200);
    const bad = await agent.post('/setup', {
      setup_token: 'nope',
      password: 'Recover-Horse-1',
      password_confirm: 'Recover-Horse-1',
    });
    assert.equal(bad.status, 401);
    const done = await agent.post('/setup', {
      setup_token: 'recover-token',
      password: 'Recover-Horse-1',
      password_confirm: 'Recover-Horse-1',
    });
    assert.equal(done.status, 302);
    const state = await pool.query(`SELECT failed_attempts, locked_until FROM users WHERE user_id = $1`, [id]);
    assert.equal(state.rows[0].failed_attempts, 0);
    assert.equal(state.rows[0].locked_until, null);
    const sessions = await pool.query(`SELECT 1 FROM session WHERE sid = $1`, [sid]);
    assert.equal(sessions.rowCount, 0);
    assert.equal((await createAgent(base).login('superadmin', 'Recover-Horse-1')).status, 302);
    const log = await pool.query(
      `SELECT changes::text AS changes FROM change_log WHERE entity = 'first-run setup' ORDER BY change_id DESC LIMIT 3`
    );
    const blob = log.rows.map((row) => row.changes).join('\n');
    assert.match(blob, /password reset/);
    assert.doesNotMatch(blob, /recover-token/);
    assert.doesNotMatch(blob, /Recover-Horse/);

    await pool.query(
      `UPDATE users SET failed_attempts = 4, locked_until = CURRENT_TIMESTAMP + interval '10 minutes' WHERE username = 'clerk'`
    );
    const admin = createAgent(base);
    assert.equal((await admin.login('superadmin', 'Recover-Horse-1')).status, 302);
    const users = await admin.get('/users');
    assert.match(users.text, /Unlock/);
    const clerk = await pool.query(`SELECT user_id FROM users WHERE username = 'clerk'`);
    const unlocked = await admin.post(`/users/${clerk.rows[0].user_id}/unlock`, {});
    assert.match(unlocked.location, /unlocked/i);
    const clerkState = await pool.query(`SELECT failed_attempts, locked_until FROM users WHERE username = 'clerk'`);
    assert.equal(clerkState.rows[0].failed_attempts, 0);
    assert.equal(clerkState.rows[0].locked_until, null);
  } finally {
    await pool.query(
      `UPDATE users SET password_hash = $1, failed_attempts = 0, locked_until = NULL WHERE user_id = $2`,
      [original.rows[0].password_hash, id]
    );
    await pool.query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = 'clerk'`);
    await pool.query(`DELETE FROM session WHERE sid = $1`, [sid]);
    delete process.env.SETUP_TOKEN;
    delete process.env.ADMIN_RECOVERY;
  }
});

test('setup, sign-in, and set password submit the fields the page actually renders', async () => {
  const original = await pool.query(`SELECT user_id, password_hash FROM users WHERE username = 'superadmin'`);
  const clerkBefore = await pool.query(`SELECT password_hash FROM users WHERE username = 'clerk'`);
  process.env.SETUP_TOKEN = 'browser-setup-token';
  process.env.ADMIN_RECOVERY = 'true';
  const jar = browserJar();
  try {
    const setupPage = await fetch(`${base}/setup`, { headers: { cookie: jar.header() } });
    jar.absorb(setupPage);
    const setupHtml = await setupPage.text();
    assert.equal(setupPage.status, 200);
    const setupForm = parseForms(setupHtml)[0];
    const setupBody = await submitRenderedForm(setupHtml, setupForm, {
      password: 'Browser-Horse-1',
      token: 'browser-setup-token',
      requiredNames: { username: 1, 'new-password': 1, 'confirm-password': 1, setup_token: 1, _csrf: 1 },
    });
    const setupPost = await fetch(`${base}${setupForm.action}`, {
      method: 'POST',
      headers: { cookie: jar.header(), 'content-type': setupForm.enctype },
      body: setupBody.body,
      redirect: 'manual',
    });
    assert.equal(setupPost.status, 302, await setupPost.text());

    const loginJar = browserJar();
    const loginPage = await fetch(`${base}/login`, { headers: { cookie: loginJar.header() } });
    loginJar.absorb(loginPage);
    const loginHtml = await loginPage.text();
    const loginForm = parseForms(loginHtml)[0];
    const loginBody = await submitRenderedForm(loginHtml, loginForm, {
      password: 'Browser-Horse-1',
      username: 'superadmin',
      requiredNames: { username: 1, password: 1, _csrf: 1 },
    });
    const loginPost = await fetch(`${base}${loginForm.action}`, {
      method: 'POST',
      headers: { cookie: loginJar.header(), 'content-type': loginForm.enctype },
      body: loginBody.body,
      redirect: 'manual',
    });
    loginJar.absorb(loginPost);
    assert.equal(loginPost.status, 302);

    const usersPage = await fetch(`${base}/users`, { headers: { cookie: loginJar.header() } });
    const usersHtml = await usersPage.text();
    assert.equal(usersPage.status, 200);
    const passwordForm = parseForms(usersHtml).find((item) => item.action.endsWith('/password') && item.inputs.some((input) => input.value === 'clerk'));
    assert.ok(passwordForm);
    const setBody = await submitRenderedForm(usersHtml, passwordForm, {
      password: 'Clerk-Browser-1',
      requiredNames: { username: 1, 'new-password': 1, 'confirm-password': 1, _csrf: 1 },
    });
    const setPost = await fetch(`${base}${passwordForm.action}`, {
      method: 'POST',
      headers: { cookie: loginJar.header(), 'content-type': passwordForm.enctype },
      body: setBody.body,
      redirect: 'manual',
    });
    assert.equal(setPost.status, 302, await setPost.text());
    const clerkJar = browserJar();
    const clerkPage = await fetch(`${base}/login`, { headers: { cookie: clerkJar.header() } });
    clerkJar.absorb(clerkPage);
    const clerkHtml = await clerkPage.text();
    const clerkForm = parseForms(clerkHtml)[0];
    const clerkBody = await submitRenderedForm(clerkHtml, clerkForm, {
      password: 'Clerk-Browser-1',
      username: 'clerk',
    });
    const clerkPost = await fetch(`${base}${clerkForm.action}`, {
      method: 'POST',
      headers: { cookie: clerkJar.header(), 'content-type': clerkForm.enctype },
      body: clerkBody.body,
      redirect: 'manual',
    });
    assert.equal(clerkPost.status, 302);
  } finally {
    await pool.query(
      `UPDATE users SET password_hash = $1, failed_attempts = 0, locked_until = NULL WHERE user_id = $2`,
      [original.rows[0].password_hash, original.rows[0].user_id]
    );
    await pool.query(`UPDATE users SET password_hash = $1 WHERE username = 'clerk'`, [clerkBefore.rows[0].password_hash]);
    delete process.env.SETUP_TOKEN;
    delete process.env.ADMIN_RECOVERY;
  }
});
