const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool, query } = require('../db');
const { can, permissionFlags, roleLabel } = require('./permissions');
const { pageName, recordId, clientIp, writeSessionEvent } = require('./activity');

const IDLE_MS = (Number(process.env.SESSION_IDLE_MINUTES) || 30) * 60 * 1000;
const ABSOLUTE_MS = (Number(process.env.SESSION_ABSOLUTE_HOURS) || 8) * 60 * 60 * 1000;
const ipHits = new Map();

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required');
  }
  if (!global.__atmSessionSecret) {
    global.__atmSessionSecret = crypto.randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET is not set. Using a temporary secret for this process.');
  }
  return global.__atmSessionSecret;
}

function tooManyLoginAttempts(ip) {
  const now = Date.now();
  const row = ipHits.get(ip) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (now > row.reset) {
    row.count = 0;
    row.reset = now + 15 * 60 * 1000;
  }
  row.count += 1;
  ipHits.set(ip, row);
  return row.count > 30;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  const parts = header.split(';').map((part) => part.trim());
  const found = parts.find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}

function tokensMatch(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function csrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function csrfOk(req) {
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  return tokensMatch(req.session && req.session.csrfToken, sent);
}

function deny(req, res) {
  res.locals.accessDenied = true;
  res.status(403);
  const { renderPage } = require('../http');
  return renderPage(req, res, 'forbidden', { title: 'Access Denied', statusCode: 403 });
}

function requireLogin(req, res, next) {
  if (req.path === '/login' || req.path === '/health') return next();
  const user = req.session && req.session.user;
  if (user && req.session.absoluteUntil && Date.now() > req.session.absoluteUntil) {
    const started = req.session.loginAt;
    writeSessionEvent(query, {
      event: 'timeout',
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
    }).catch((err) => console.error(err));
    return req.session.destroy(() => {
      res.clearCookie('atm.sid');
      res.redirect('/login?reason=expired');
    });
  }
  if (!user) {
    const expired = readCookie(req, 'atm.seen') === '1';
    return res.redirect(expired ? '/login?reason=expired' : '/login');
  }
  req.user = user;
  return next();
}

function requireCan(action) {
  return (req, res, next) => {
    if (can(req.user, action)) return next();
    return deny(req, res);
  };
}

function guard(router, action) {
  const check = requireCan(action);
  const wrap = express.Router();
  wrap.use((req, res, next) => {
    const method = req.method.toLowerCase();
    const handled = router.stack.some((layer) => {
      if (!layer.route || !layer.route.methods[method]) return false;
      return layer.match(req.path);
    });
    if (!handled) return next('router');
    return check(req, res, next);
  });
  wrap.use(router);
  return wrap;
}

function requireAny(...actions) {
  return (req, res, next) => {
    if (actions.some((action) => can(req.user, action))) return next();
    return deny(req, res);
  };
}

function installAuth(app) {
  app.use(session({
    store: new PgSession({
      pool,
      tableName: 'session',
      createTableIfMissing: false,
      pruneSessionInterval: false,
    }),
    name: 'atm.sid',
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: IDLE_MS,
    },
  }));

  app.use((req, res, next) => {
    const token = csrfToken(req);
    const user = req.session.user || null;
    res.locals.csrfField = `<input type="hidden" name="_csrf" value="${token}">`;
    res.locals.currentUser = user;
    res.locals.roleLabel = roleLabel;
    res.locals.can = user ? permissionFlags(user) : permissionFlags(null);
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const type = req.headers['content-type'] || '';
    if (type.includes('multipart/form-data')) return next();
    if (!csrfOk(req)) {
      res.locals.accessDenied = true;
      return res.status(403).type('html').send('<!DOCTYPE html><html><body><main class="content"><h1>The form expired.</h1><p>Go back, refresh the page, and submit it again.</p></main></body></html>');
    }
    return next();
  });

  app.use(require('./routes'));

  app.use(requireLogin);

  app.use((req, res, next) => {
    if (req.user) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use((req, res, next) => {
    res.on('finish', () => {
      if (!req.user) return;
      const outcome = res.locals.accessDenied || res.statusCode === 403 ? 'denied' : 'allowed';
      query(
        `INSERT INTO access_log
           (user_id, username, role, session_id, method, page_name, path, record_id, outcome, status_code, region, branch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          req.user.user_id,
          req.user.username,
          req.user.role,
          req.sessionID,
          req.method,
          pageName(req.path),
          req.originalUrl.slice(0, 300),
          recordId(req),
          outcome,
          res.statusCode,
          req.user.region,
          req.user.branch_id,
        ]
      ).catch((err) => console.error(err));
    });
    next();
  });
}

module.exports = {
  installAuth,
  requireCan,
  requireAny,
  guard,
  deny,
  csrfOk,
  tooManyLoginAttempts,
  clientIp,
  IDLE_MS,
  ABSOLUTE_MS,
};
