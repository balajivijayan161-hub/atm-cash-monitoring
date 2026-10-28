const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage } = require('../http');
const { requireCan } = require('../auth/gate');
const { hashPassword } = require('../auth/password');
const { roleLabel } = require('../auth/permissions');
const { recordChange } = require('../auth/activity');

const router = express.Router();
const ROLES = ['super_admin', 'regional_manager', 'branch_manager', 'clerk', 'custodian', 'engineer'];

function cleanUser(body) {
  const role = ROLES.includes(body.role) ? body.role : '';
  return {
    username: String(body.username || '').trim().slice(0, 40),
    full_name: String(body.full_name || '').trim().slice(0, 120),
    role,
    region: String(body.region || '').trim().slice(0, 40) || null,
    branch_id: body.branch_id ? Number(body.branch_id) : null,
    custodian_id: body.custodian_id ? Number(body.custodian_id) : null,
    engineer_id: body.engineer_id ? Number(body.engineer_id) : null,
    active: body.active === 'on' || body.active === 'true',
    password: String(body.password || ''),
  };
}

router.get('/users', requireCan('manageUsers'), asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT user_id, username, full_name, role, region, active, created_at, updated_at
     FROM users ORDER BY username`
  );
  renderPage(req, res, 'users', { title: 'User Accounts', rows: rows.rows, roleLabel });
}));

router.get('/users/new', requireCan('manageUsers'), asyncRoute(async (req, res) => {
  renderPage(req, res, 'user-form', {
    title: 'New User',
    editing: null,
    form: { username: '', full_name: '', role: 'clerk', region: '', branch_id: '', custodian_id: '', engineer_id: '', active: true },
    roles: ROLES,
    roleLabel,
    errors: [],
  });
}));

router.post('/users', requireCan('manageUsers'), asyncRoute(async (req, res) => {
  const form = cleanUser(req.body);
  const errors = [];
  if (!/^[a-z0-9.]{3,40}$/.test(form.username)) errors.push('Username must be 3 to 40 letters, digits, or dots.');
  if (!form.full_name) errors.push('Enter the full name.');
  if (!form.role) errors.push('Choose a role.');
  if (form.password.length < 8) errors.push('Password must be at least 8 characters.');
  if (errors.length) {
    return renderPage(req, res, 'user-form', {
      title: 'New User', editing: null, form, roles: ROLES, roleLabel, errors, statusCode: 400,
    });
  }
  const hash = await hashPassword(form.password);
  const inserted = await query(
    `INSERT INTO users
       (username, full_name, role, region, branch_id, custodian_id, engineer_id, password_hash, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING user_id`,
    [form.username, form.full_name, form.role, form.region, form.branch_id, form.custodian_id, form.engineer_id, hash, form.active]
  );
  await recordChange(req, {
    action: 'create',
    entity: 'user',
    entityId: inserted.rows[0].user_id,
    before: null,
    after: { username: form.username, role: form.role, active: form.active, region: form.region },
    region: form.region,
    branchId: form.branch_id,
  });
  res.redirect('/users?notice=User account created.');
}));

router.post('/users/:id', requireCan('manageUsers'), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await query('SELECT * FROM users WHERE user_id = $1', [id]);
  if (!existing.rowCount) return renderPage(req, res, 'not-found', { title: 'User Not Found', statusCode: 404 });
  const form = cleanUser(req.body);
  const before = {
    full_name: existing.rows[0].full_name,
    role: existing.rows[0].role,
    region: existing.rows[0].region,
    active: existing.rows[0].active,
  };
  await query(
    `UPDATE users
     SET full_name = $2, role = $3, region = $4, branch_id = $5, custodian_id = $6, engineer_id = $7,
         active = $8, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $1`,
    [id, form.full_name, form.role || existing.rows[0].role, form.region, form.branch_id, form.custodian_id, form.engineer_id, form.active]
  );
  if (form.password) {
    if (form.password.length < 8) {
      return renderPage(req, res, 'user-form', {
        title: 'Edit User',
        editing: existing.rows[0],
        form,
        roles: ROLES,
        roleLabel,
        errors: ['Password must be at least 8 characters.'],
        statusCode: 400,
      });
    }
    await query('UPDATE users SET password_hash = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1', [id, await hashPassword(form.password)]);
  }
  await recordChange(req, {
    action: 'update',
    entity: 'user',
    entityId: id,
    before,
    after: { full_name: form.full_name, role: form.role, region: form.region, active: form.active, password: form.password ? 'reset' : undefined },
    region: form.region,
    branchId: form.branch_id,
  });
  res.redirect('/users?notice=User account updated.');
}));

module.exports = router;
