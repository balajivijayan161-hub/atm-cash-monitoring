const express = require('express');
const { query } = require('../db');
const { checkPassword, hashPassword, secretMatch } = require('./password');
const { lockoutSeconds, setupOpen, envSecret, recoveryEnabled, endUserSessions } = require('./accounts');
const { writeSessionEvent, clientIp, recordUnsignedChange } = require('./activity');
const { tooManyLoginAttempts, ABSOLUTE_MS } = require('./gate');
const { renderPage, formText } = require('../http');

const router = express.Router();
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

function loginPage(res, data) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(data.statusCode || 200).render('login', {
    error: '',
    reason: '',
    username: '',
    lockSeconds: 0,
    ...data,
  });
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const reason = req.query.reason === 'expired' ? 'expired' : (req.query.setup === 'done' ? 'ready' : '');
  return loginPage(res, { reason });
});

function setupDisabled(res) {
  return renderPage({ query: {} }, res, 'not-found', { title: 'Page Not Found', statusCode: 404 });
}

async function logSetup(req, outcome, userId) {
  await recordUnsignedChange({
    username: 'superadmin',
    role: 'super_admin',
    userId,
    sessionId: req.sessionID,
    action: 'update',
    entity: 'first-run setup',
    entityId: userId,
    changes: [{ field: 'result', before: null, after: outcome }],
  });
}

router.get('/setup', async (req, res, next) => {
  try {
    if (!(await setupOpen())) return setupDisabled(res);
    res.setHeader('Cache-Control', 'no-store');
    return res.render('setup', { error: '' });
  } catch (err) {
    return next(err);
  }
});

router.post('/setup', async (req, res, next) => {
  try {
    if (!(await setupOpen())) return setupDisabled(res);
    const account = await query(
      `SELECT user_id FROM users WHERE username = 'superadmin'`
    );
    const userId = account.rows[0] ? account.rows[0].user_id : null;
    const token = formText(req.body, 'setup_token');
    if (!secretMatch(envSecret('SETUP_TOKEN'), token)) {
      await logSetup(req, 'rejected', userId);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(401).render('setup', { error: 'The setup token does not match.' });
    }
    const password = formText(req.body, 'new-password', 'password');
    const confirm = formText(req.body, 'confirm-password', 'password_confirm');
    if (password.length < 12 || password !== confirm) {
      await logSetup(req, 'rejected', userId);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).render('setup', {
        error: password.length < 12 ? 'Use at least 12 characters.' : 'The passwords do not match.',
      });
    }
    const saved = await query(
      `UPDATE users
       SET password_hash = $1, failed_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE username = 'superadmin' AND ($2::boolean OR password_hash IS NULL)
       RETURNING user_id`,
      [await hashPassword(password), recoveryEnabled()]
    );
    if (!saved.rowCount) return setupDisabled(res);
    await endUserSessions(saved.rows[0].user_id);
    await logSetup(req, recoveryEnabled() ? 'password reset' : 'password set', saved.rows[0].user_id);
    return res.redirect('/login?setup=done');
  } catch (err) {
    return next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const username = formText(req.body, 'username').trim().slice(0, 40);
    const password = formText(req.body, 'password');
    const ip = clientIp(req);
    const userAgent = req.get('user-agent');
    if (tooManyLoginAttempts(ip)) {
      return loginPage(res, {
        statusCode: 429,
        error: 'Too many sign-in attempts from this network. Try again in 15 minutes.',
        username,
      });
    }
    const found = await query(
      `SELECT user_id, username, full_name, role, region, branch_id, custodian_id, engineer_id,
              password_hash, active, failed_attempts, locked_until
       FROM users WHERE username = $1`,
      [username]
    );
    const account = found.rows[0];
    const locked = account && account.active && lockoutSeconds(account.locked_until) > 0;
    const match = await checkPassword(password, account && account.active && !locked ? account.password_hash : null);
    if (locked) {
      await writeSessionEvent(null, {
        event: 'lockout',
        userId: account.user_id,
        username: account.username,
        role: account.role,
        ip,
        userAgent,
        sessionId: req.sessionID,
        region: account.region,
      });
      return loginPage(res, { statusCode: 401, error: 'Invalid username or password.', username });
    }
    if (!match) {
      if (account && account.active) {
        const fails = account.failed_attempts + 1;
        const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS) : null;
        await query(
          `UPDATE users SET failed_attempts = $2, locked_until = $3, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`,
          [account.user_id, lock ? 0 : fails, lock]
        );
      }
      await writeSessionEvent(null, {
        event: 'failure',
        userId: account ? account.user_id : null,
        username: username || 'unknown',
        role: account ? account.role : null,
        ip,
        userAgent,
        sessionId: req.sessionID,
        region: account ? account.region : null,
      });
      return loginPage(res, { statusCode: 401, error: 'Invalid username or password.', username });
    }
    await query(
      `UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`,
      [account.user_id]
    );
    const user = {
      user_id: account.user_id,
      username: account.username,
      full_name: account.full_name,
      role: account.role,
      region: account.region,
      branch_id: account.branch_id,
      custodian_id: account.custodian_id,
      engineer_id: account.engineer_id,
      active: true,
    };
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = user;
      req.session.loginAt = Date.now();
      req.session.absoluteUntil = Date.now() + ABSOLUTE_MS;
      req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
      res.cookie('atm.seen', '1', {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: ABSOLUTE_MS,
      });
      writeSessionEvent(null, {
        event: 'success',
        userId: user.user_id,
        username: user.username,
        role: user.role,
        ip,
        userAgent,
        sessionId: req.sessionID,
        loginAt: new Date(),
        region: user.region,
      }).catch((logErr) => console.error(logErr));
      return res.redirect('/');
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res) => {
  const user = req.session.user;
  const started = req.session.loginAt;
  const finish = () => {
    res.clearCookie('atm.sid');
    res.clearCookie('atm.seen');
    res.redirect('/login');
  };
  if (!user) return req.session.destroy(() => finish());
  writeSessionEvent(null, {
    event: 'logout',
    userId: user.user_id,
    username: user.username,
    role: user.role,
    ip: clientIp(req),
    userAgent: req.get('user-agent'),
    sessionId: req.sessionID,
    loginAt: started ? new Date(started) : null,
    logoutAt: new Date(),
    durationSeconds: started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : null,
    region: user.region,
  }).catch((err) => console.error(err)).finally(() => {
    req.session.destroy(() => finish());
  });
});

module.exports = router;
