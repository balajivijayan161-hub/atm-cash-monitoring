const { query } = require('../db');
const { hashPassword } = require('./password');

const DEMO_USERS = [
  { username: 'superadmin', fullName: 'Super Admin', role: 'super_admin' },
  { username: 'regional.manager', fullName: 'Regional Manager', role: 'regional_manager' },
  { username: 'branch.manager', fullName: 'Branch Manager', role: 'branch_manager' },
  { username: 'clerk', fullName: 'Cash Officer', role: 'clerk' },
  { username: 'custodian', fullName: 'Custodian', role: 'custodian' },
  { username: 'engineer', fullName: 'Field Engineer', role: 'engineer' },
];

function envSecret(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

async function loadAnchors(client) {
  const db = client || { query };
  const branch = await db.query(
    `SELECT b.branch_id, l.region
     FROM branches b
     JOIN locations l ON l.location_id = b.location_id
     WHERE l.location_code = 'MUM'
     ORDER BY b.branch_id
     LIMIT 1`
  );
  const custodian = await db.query(
    `SELECT c.custodian_id, l.region
     FROM custodians c
     JOIN cash_vans v ON v.van_id = c.van_id
     JOIN locations l ON l.location_id = v.location_id
     WHERE l.location_code = 'MUM' AND c.active
     ORDER BY c.custodian_id
     LIMIT 1`
  );
  const engineer = await db.query(
    `SELECT e.engineer_id, l.region
     FROM engineers e
     JOIN locations l ON l.location_id = e.location_id
     WHERE l.location_code = 'MUM' AND e.active
     ORDER BY e.engineer_id
     LIMIT 1`
  );
  return {
    branchId: branch.rows[0]?.branch_id || null,
    region: branch.rows[0]?.region || 'West',
    custodianId: custodian.rows[0]?.custodian_id || null,
    engineerId: engineer.rows[0]?.engineer_id || null,
  };
}

async function seedAccessUsers(client) {
  const db = client || { query };
  const anchors = await loadAnchors(db);
  const adminPassword = envSecret('ADMIN_PASSWORD');
  const demoPassword = envSecret('DEMO_PASSWORD');
  for (const account of DEMO_USERS) {
    const password = account.role === 'super_admin' ? adminPassword : demoPassword;
    const region = account.role === 'super_admin' ? null : anchors.region;
    const branchId = account.role === 'branch_manager' || account.role === 'clerk' ? anchors.branchId : null;
    const custodianId = account.role === 'custodian' ? anchors.custodianId : null;
    const engineerId = account.role === 'engineer' ? anchors.engineerId : null;
    const hash = password ? await hashPassword(password) : null;
    if (hash) {
      await db.query(
        `INSERT INTO users
           (username, full_name, role, region, branch_id, custodian_id, engineer_id, password_hash, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
         ON CONFLICT (username) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               full_name = EXCLUDED.full_name,
               role = EXCLUDED.role,
               region = EXCLUDED.region,
               branch_id = EXCLUDED.branch_id,
               custodian_id = EXCLUDED.custodian_id,
               engineer_id = EXCLUDED.engineer_id,
               active = TRUE,
               updated_at = CURRENT_TIMESTAMP`,
        [account.username, account.fullName, account.role, region, branchId, custodianId, engineerId, hash]
      );
    } else {
      await db.query(
        `INSERT INTO users
           (username, full_name, role, region, branch_id, custodian_id, engineer_id, password_hash, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, TRUE)
         ON CONFLICT (username) DO UPDATE
           SET full_name = EXCLUDED.full_name,
               role = EXCLUDED.role,
               region = EXCLUDED.region,
               branch_id = EXCLUDED.branch_id,
               custodian_id = EXCLUDED.custodian_id,
               engineer_id = EXCLUDED.engineer_id,
               active = TRUE,
               updated_at = CURRENT_TIMESTAMP`,
        [account.username, account.fullName, account.role, region, branchId, custodianId, engineerId]
      );
    }
  }
}

async function setupOpen(db) {
  const runner = db || { query };
  if (!envSecret('SETUP_TOKEN')) return false;
  const row = await runner.query(
    `SELECT password_hash IS NULL AS open FROM users WHERE username = 'superadmin'`
  );
  return Boolean(row.rows[0] && row.rows[0].open);
}

function lockoutSeconds(lockedUntil, now = new Date()) {
  if (!lockedUntil) return 0;
  const end = lockedUntil instanceof Date ? lockedUntil : new Date(lockedUntil);
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 1000));
}

module.exports = { seedAccessUsers, lockoutSeconds, DEMO_USERS, envSecret, setupOpen };
