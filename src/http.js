function asArray(value) {
  if (value == null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function intOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function likePattern(value) {
  return `%${String(value).replace(/[\\%_]/g, '\\$&')}%`;
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function renderPage(req, res, view, data = {}) {
  const locals = { ...data };
  res.render(view, locals, (err, html) => {
    if (err) return res.status(500).type('html').send(errorDocument(err));
    res.render('layout', { ...locals, pageBody: html }, (layoutErr, full) => {
      if (layoutErr) return res.status(500).type('html').send(errorDocument(layoutErr));
      res.status(data.statusCode || 200).send(full);
    });
  });
}

function errorDocument(err) {
  console.error(err);
  const detail = process.env.NODE_ENV === 'production' ? '' : `<pre>${escapeHtml(err.message || String(err))}</pre>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Ledger error</title>
  <link rel="stylesheet" href="/css/app.css"></head><body>
  <main class="content"><h1>The ledger could not complete that request.</h1>
  <p>Refresh the page. If you just started the app, the database may still be loading sample data.</p>
  ${detail}</main></body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inr(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const fraction = Number.isInteger(n) ? 0 : 2;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  }).format(n);
}

function pct(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(2)}%`;
}

function prettyDate(value) {
  if (!value) return '—';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && value.length === 10) {
    const [year, month, day] = value.split('-').map(Number);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${String(day).padStart(2, '0')} ${months[month - 1]} ${year}`;
  }
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(dt);
}

function prettyDateTime(value) {
  if (!value) return '—';
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Kolkata',
  }).format(dt);
}

function pageHref(base, query, page) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '' && key !== 'page') {
      params.set(key, String(value));
    }
  }
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

module.exports = {
  asArray,
  isIsoDate,
  intOrNull,
  likePattern,
  asyncRoute,
  renderPage,
  errorDocument,
  inr,
  pct,
  prettyDate,
  prettyDateTime,
  pageHref,
};
