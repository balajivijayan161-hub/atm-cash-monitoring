const { query } = require('../db');

const PAGE_RULES = [
  [/^\/$/, 'Uptime Dashboard'],
  [/^\/login$/, 'Sign In'],
  [/^\/logout$/, 'Log Out'],
  [/^\/atms\/\d+$/, 'ATM Detail'],
  [/^\/atms$/, 'ATMs'],
  [/^\/forecast$/, 'Cash Forecast'],
  [/^\/runs\/new$/, 'New Replenishment Run'],
  [/^\/runs\/\d+\/delete$/, 'Delete Replenishment Run'],
  [/^\/runs\/\d+\/approve$/, 'Approve Replenishment Run'],
  [/^\/runs\/\d+$/, 'Replenishment Run'],
  [/^\/runs\/plan$/, 'Plan Replenishment'],
  [/^\/runs$/, 'Replenishment Runs'],
  [/^\/reconciliations\/new$/, 'New Reconciliation'],
  [/^\/reconciliations\/\d+\/approve$/, 'Approve Reconciliation'],
  [/^\/reconciliations$/, 'Reconciliations'],
  [/^\/tickets\/\d+\/assign$/, 'Assign Fault Ticket'],
  [/^\/tickets\/\d+\/close$/, 'Close Fault Ticket'],
  [/^\/tickets$/, 'Fault Tickets'],
  [/^\/reports\/downtime-atms$/, 'Downtime Above 5%'],
  [/^\/reports\/van-cashouts$/, 'Van Cash-Outs'],
  [/^\/reports\/withdrawal-matrix$/, 'Withdrawal Matrix'],
  [/^\/reports\/downtime-by-location$/, 'Downtime by Location'],
  [/^\/switch\/\d+$/, 'Bank Data Import Detail'],
  [/^\/switch$/, 'Bank Data Import'],
  [/^\/imports\/\d+$/, 'Import Detail'],
  [/^\/imports$/, 'Import History'],
  [/^\/alerts$/, 'Cash Alerts'],
  [/^\/downtime\/\d+\/close$/, 'Close Downtime'],
  [/^\/downtime$/, 'Open Downtime'],
  [/^\/live-feed\//, 'Live Feed'],
  [/^\/operations\/ej-archive$/, 'Electronic Journal Archive'],
  [/^\/users\/\d+$/, 'User Account'],
  [/^\/users$/, 'User Accounts'],
  [/^\/activity\/export$/, 'Activity Export'],
  [/^\/activity$/, 'Activity'],
];

function pageName(path) {
  const found = PAGE_RULES.find(([pattern]) => pattern.test(path));
  return found ? found[1] : 'Page';
}

function recordId(req) {
  const raw = req.params.id || req.query.atm_id || req.query.ticket || req.query.run_id || '';
  const text = String(raw || '').slice(0, 40);
  return text || null;
}

function clientIp(req) {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim().slice(0, 64);
  return (req.ip || '').slice(0, 64);
}

async function writeSessionEvent(client, row) {
  const db = client && client.query ? client : { query };
  await db.query(
    `INSERT INTO session_log
       (event, user_id, username, role, ip, user_agent, session_id, login_at, logout_at, duration_seconds, region)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      row.event,
      row.userId || null,
      String(row.username || '').slice(0, 40),
      row.role || null,
      row.ip || null,
      row.userAgent ? String(row.userAgent).slice(0, 400) : null,
      row.sessionId || null,
      row.loginAt || null,
      row.logoutAt || null,
      row.durationSeconds == null ? null : row.durationSeconds,
      row.region || null,
    ]
  );
}

function fieldChanges(before, after) {
  const left = before || {};
  const right = after || {};
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .map((field) => ({ field, before: left[field] == null ? null : left[field], after: right[field] == null ? null : right[field] }));
}

async function recordChange(req, { action, entity, entityId, before, after, region, branchId }, client) {
  if (!req || !req.user) return;
  const db = client && client.query ? client : { query };
  const changes = fieldChanges(before, after);
  await db.query(
    `INSERT INTO change_log
       (user_id, username, role, session_id, action, entity, entity_id, changes, region, branch_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
    [
      req.user.user_id,
      req.user.username,
      req.user.role,
      req.sessionID || null,
      action,
      entity,
      entityId == null ? null : String(entityId),
      JSON.stringify(changes),
      region || req.user.region || null,
      branchId || req.user.branch_id || null,
    ]
  );
}

module.exports = {
  pageName,
  recordId,
  clientIp,
  writeSessionEvent,
  fieldChanges,
  recordChange,
};
