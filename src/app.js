const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { query } = require('./db');
const { installAuth } = require('./auth/gate');
const {
  asyncRoute,
  renderPage,
  errorDocument,
  inr,
  pct,
  prettyDate,
  prettyDateTime,
  exactDateTime,
  pageHref,
  titleCase,
  sourceLabel,
  batchName,
  formatLabel,
} = require('./http');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    strictTransportSecurity: process.env.NODE_ENV === 'production' ? undefined : false,
  }));

  app.locals.inr = inr;
  app.locals.pct = pct;
  app.locals.prettyDate = prettyDate;
  app.locals.prettyDateTime = prettyDateTime;
  app.locals.exactDateTime = exactDateTime;
  app.locals.pageHref = pageHref;
  app.locals.label = titleCase;
  app.locals.sourceLabel = sourceLabel;
  app.locals.batchName = batchName;
  app.locals.formatLabel = formatLabel;
  app.locals.jsonScript = (value) => JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.locals.notice = typeof req.query.notice === 'string' ? req.query.notice.slice(0, 400) : '';
    res.locals.warning = typeof req.query.warning === 'string' ? req.query.warning.slice(0, 400) : '';
    res.locals.navClass = (href) => {
      if (href === '/') return req.path === '/' ? 'active' : '';
      return req.path === href || req.path.startsWith(`${href}/`) ? 'active' : '';
    };
    next();
  });

  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist')));
  app.use('/samples', express.static(path.join(__dirname, '..', 'samples'), { index: false }));

  installAuth(app);

  app.get('/health', asyncRoute(async (req, res) => {
    try {
      const [atms, meta] = await Promise.all([
        query('SELECT COUNT(*)::int AS atms FROM atms'),
        query(`SELECT value FROM app_meta WHERE key = 'seeded'`),
      ]);
      res.json({
        status: 'ok',
        db: 'up',
        atms: atms.rows[0].atms,
        seeded: meta.rowCount > 0,
        service: 'atm-cash-monitoring',
        time: new Date().toISOString(),
      });
    } catch (err) {
      console.error(err);
      res.status(503).json({ status: 'error', db: 'down', service: 'atm-cash-monitoring' });
    }
  }));

  app.use(require('./routes/dashboard'));
  app.use(require('./routes/atms'));
  app.use(require('./routes/forecast'));
  app.use(require('./routes/runs'));
  app.use(require('./routes/reconciliations'));
  app.use(require('./routes/tickets'));
  app.use(require('./routes/reports'));
  app.use(require('./routes/switch'));
  app.use(require('./routes/imports'));
  app.use(require('./routes/lists'));
  app.use(require('./routes/simulator'));
  app.use(require('./routes/operations'));
  app.use(require('./routes/users'));
  app.use(require('./routes/activity'));

  app.use((req, res) => {
    renderPage(req, res, 'not-found', { title: 'Page Not Found', statusCode: 404 });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).type('html').send(errorDocument(err));
  });

  return app;
}

module.exports = { createApp };
