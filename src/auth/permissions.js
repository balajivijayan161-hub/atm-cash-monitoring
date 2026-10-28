const ROLE_LABELS = {
  super_admin: 'Super Admin',
  regional_manager: 'Regional Manager',
  branch_manager: 'Branch Manager',
  clerk: 'Cash Officer',
  custodian: 'Custodian',
  engineer: 'Engineer',
};

const GRANTS = {
  super_admin: ['*'],
  regional_manager: [
    'dashboard', 'atms', 'runs', 'recons', 'tickets', 'reports', 'forecast', 'alerts', 'downtime',
    'planRuns', 'createRun', 'editRun', 'deleteRun', 'approveRuns', 'approveRecons', 'createRecon',
    'importData', 'activity', 'journals', 'assignTickets',
  ],
  branch_manager: [
    'dashboard', 'atms', 'runs', 'recons', 'tickets', 'reports', 'forecast', 'alerts', 'downtime',
    'planRuns', 'createRun', 'editRun', 'deleteRun', 'approveRecons', 'createRecon', 'assignTickets', 'journals',
  ],
  clerk: [
    'dashboard', 'atms', 'runs', 'recons', 'tickets', 'reports', 'forecast', 'alerts', 'downtime',
    'createRun', 'editRun', 'createRecon',
  ],
  custodian: ['dashboard', 'atms', 'runs', 'alerts', 'editOwnRun'],
  engineer: ['dashboard', 'atms', 'tickets', 'downtime', 'alerts', 'editOwnTicket', 'editOwnDowntime'],
};

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

function can(user, action) {
  if (!user || !user.active) return false;
  const grants = GRANTS[user.role] || [];
  return grants.includes('*') || grants.includes(action);
}

function permissionFlags(user) {
  const actions = [
    'dashboard', 'atms', 'runs', 'recons', 'tickets', 'reports', 'forecast', 'alerts', 'downtime',
    'planRuns', 'createRun', 'editRun', 'deleteRun', 'approveRuns', 'approveRecons', 'createRecon',
    'importData', 'liveFeed', 'activity', 'manageUsers', 'journals', 'assignTickets',
    'editOwnRun', 'editOwnTicket', 'editOwnDowntime',
  ];
  const flags = {};
  for (const action of actions) flags[action] = can(user, action) || (user && user.role === 'super_admin');
  flags.liveFeed = user && user.role === 'super_admin';
  flags.manageUsers = user && user.role === 'super_admin';
  return flags;
}

function scopeBinds(user) {
  return [
    user && user.role === 'regional_manager' ? user.region : null,
    user && (user.role === 'branch_manager' || user.role === 'clerk') ? user.branch_id : null,
    user && user.role === 'custodian' ? user.custodian_id : null,
    user && user.role === 'engineer' ? user.engineer_id : null,
  ];
}

function atmScopeSql(start) {
  const r = start;
  const b = start + 1;
  const c = start + 2;
  const e = start + 3;
  return `SELECT sa.atm_id
    FROM atms sa
    JOIN branches sb ON sb.branch_id = sa.branch_id
    JOIN locations sl ON sl.location_id = sb.location_id
    WHERE ($${r}::text IS NULL OR sl.region = $${r})
      AND ($${b}::int IS NULL OR sa.branch_id = $${b})
      AND ($${c}::int IS NULL OR EXISTS (
        SELECT 1 FROM cassette_loads cl
        JOIN replenishment_runs rr ON rr.run_id = cl.run_id
        WHERE cl.atm_id = sa.atm_id AND rr.custodian_id = $${c}
      ))
      AND ($${e}::int IS NULL OR EXISTS (
        SELECT 1 FROM fault_tickets ft
        WHERE ft.atm_id = sa.atm_id AND ft.engineer_id = $${e}
      ))`;
}

function locationScopeSql(alias, start) {
  const region = start;
  const branch = start + 1;
  const custodian = start + 2;
  const engineer = start + 3;
  return `($${region}::text IS NULL OR ${alias}.region = $${region})
    AND ($${branch}::int IS NULL OR EXISTS (
      SELECT 1 FROM branches scope_branch
      WHERE scope_branch.branch_id = $${branch}
        AND scope_branch.location_id = ${alias}.location_id
    ))
    AND (
      ($${custodian}::int IS NULL AND $${engineer}::int IS NULL)
      OR EXISTS (
        SELECT 1
        FROM atms scope_atm
        JOIN branches scope_atm_branch ON scope_atm_branch.branch_id = scope_atm.branch_id
        WHERE scope_atm_branch.location_id = ${alias}.location_id
          AND scope_atm.atm_id IN (${atmScopeSql(start)})
      )
    )`;
}

function runScopeSql(alias, start) {
  const region = start;
  const branch = start + 1;
  const custodian = start + 2;
  const engineer = start + 3;
  return `($${engineer}::int IS NULL AND ($${region}::text IS NULL OR EXISTS (
      SELECT 1 FROM locations sl WHERE sl.location_id = ${alias}.location_id AND sl.region = $${region}
    )) AND ($${branch}::int IS NULL OR EXISTS (
      SELECT 1 FROM cassette_loads cl
      JOIN atms sa ON sa.atm_id = cl.atm_id
      WHERE cl.run_id = ${alias}.run_id AND sa.branch_id = $${branch}
    ) OR (
      NOT EXISTS (SELECT 1 FROM cassette_loads cl WHERE cl.run_id = ${alias}.run_id)
      AND EXISTS (
        SELECT 1 FROM branches sb WHERE sb.branch_id = $${branch} AND sb.location_id = ${alias}.location_id
      )
    )) AND ($${custodian}::int IS NULL OR ${alias}.custodian_id = $${custodian}))`;
}

module.exports = {
  ROLE_LABELS,
  roleLabel,
  can,
  permissionFlags,
  scopeBinds,
  atmScopeSql,
  locationScopeSql,
  runScopeSql,
};
