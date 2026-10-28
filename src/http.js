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

const PG_INT_MAX = 2147483647;
const LEDGER_CENTS_MAX = 99999999999999n;

function intOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n > PG_INT_MAX) return null;
  return n;
}

function parseLedgerAmount(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = text.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  if (cents > LEDGER_CENTS_MAX) return null;
  return text;
}

function ledgerAmountError(value, label) {
  if (parseLedgerAmount(value) != null) return null;
  if (typeof value === 'string' && /^(\d+)(?:\.(\d{1,2}))?$/.test(value.trim())) return 'Amount too large.';
  return `${label} must be a number with up to 2 decimal places.`;
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
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Request failed</title>
  <link rel="stylesheet" href="/css/app.css"></head><body>
  <main class="content"><h1>That request could not be completed.</h1>
  <p>Refresh the page and try again.</p>
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

const SMALL_WORDS = new Set(['a', 'an', 'and', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

function titleCase(value) {
  const text = String(value || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.split(' ').map((word, index) => {
    const lower = word.toLowerCase();
    if (index > 0 && SMALL_WORDS.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

function sourceLabel(value) {
  const key = String(value || 'manual').toLowerCase();
  if (key === 'simulator') return 'Live Feed';
  if (key === 'schedule') return 'Scheduled Import';
  if (key === 'manual') return 'Manual Upload';
  if (key === 'trigger') return 'Reconciliation';
  if (key === 'monitor') return 'Bank Feed';
  if (key === 'seed') return 'History';
  return titleCase(key);
}

function batchKind(batch) {
  const filename = String(batch.filename || '');
  if (batch.source === 'simulator' || /^simulator-/i.test(filename) || /^switch-feed-/i.test(filename)) {
    return 'simulator';
  }
  if (batch.source === 'schedule') return 'schedule';
  if (batch.source === 'manual' || !batch.source) return 'manual';
  return 'other';
}

function batchName(batch) {
  if (!batch) return 'Feed Batch';
  const when = batch.uploaded_at ? `${prettyDateTime(batch.uploaded_at)} IST` : '';
  const kind = batchKind(batch);
  if (kind === 'simulator') return when ? `Bank Feed — ${when}` : 'Bank Feed';
  if (kind === 'schedule') return when ? `Scheduled Import — ${when}` : 'Scheduled Import';
  if (kind === 'manual') return when ? `Manual Upload — ${when}` : 'Manual Upload';
  return when ? `Feed Batch — ${when}` : (batch.batch_id ? `Feed Batch #${batch.batch_id}` : 'Feed Batch');
}

function formatLabel(value) {
  if (value === 'csv') return 'Spreadsheet';
  if (value === 'fixed') return 'Fixed Width';
  return titleCase(value);
}

function pageNumber(page) {
  const text = String(page ?? '').trim();
  if (/^[1-9]\d*$/.test(text)) {
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  }
  if (/^[1-9](?:\.\d+)?e\+?\d+$/i.test(text)) {
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed >= 1) return Number.MAX_SAFE_INTEGER;
  }
  return 1;
}

function exactDateTime(value) {
  if (!value) return '—';
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return '—';
  const formatted = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Kolkata',
  }).format(dt);
  return `${formatted} IST`;
}

function pageWindow(page, pageSize, total) {
  const size = Math.max(1, Number(pageSize) || 1);
  const count = Math.max(0, Number(total) || 0);
  const pages = Math.max(1, Math.ceil(count / size));
  const current = Math.min(pageNumber(page), pages);
  return { page: current, pages, offset: (current - 1) * size, pageSize: size, total: count };
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
  parseLedgerAmount,
  ledgerAmountError,
  likePattern,
  asyncRoute,
  renderPage,
  errorDocument,
  inr,
  pct,
  prettyDate,
  prettyDateTime,
  exactDateTime,
  titleCase,
  sourceLabel,
  batchName,
  formatLabel,
  pageHref,
  pageWindow,
};
