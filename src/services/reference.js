const { query } = require('../db');
const { scopeBinds, atmScopeSql, locationScopeSql } = require('../auth/permissions');

async function loadReference(user) {
  const scope = scopeBinds(user);
  const [locations, vans, custodians, atms, engineers] = await Promise.all([
    query(`SELECT l.location_id, l.location_code, l.location_name, l.city, l.region
           FROM locations l
           WHERE ${locationScopeSql('l', 1)}
           ORDER BY l.location_name`, scope),
    query(`SELECT v.van_id, v.van_code, v.location_id, v.registration_no, v.status
           FROM cash_vans v
           JOIN locations l ON l.location_id = v.location_id
           WHERE ${locationScopeSql('l', 1)}
           ORDER BY v.van_code`, scope),
    query(`SELECT c.custodian_id, c.full_name, c.van_id, c.employee_code, v.location_id
           FROM custodians c
           JOIN cash_vans v ON v.van_id = c.van_id
           JOIN locations l ON l.location_id = v.location_id
           WHERE c.active AND ${locationScopeSql('l', 1)}
           ORDER BY c.full_name`, scope),
    query(`SELECT a.atm_id, a.atm_code, a.site_name, a.status, a.current_cash, b.location_id, b.branch_name, l.location_name
           FROM atms a
           JOIN branches b ON b.branch_id = a.branch_id
           JOIN locations l ON l.location_id = b.location_id
           WHERE a.atm_id IN (${atmScopeSql(1)})
           ORDER BY a.atm_code`, scope),
    query(`SELECT e.engineer_id, e.full_name, e.location_id, e.specialty
           FROM engineers e
           JOIN locations l ON l.location_id = e.location_id
           WHERE e.active AND ${locationScopeSql('l', 1)}
           ORDER BY e.full_name`, scope),
  ]);
  return {
    locations: locations.rows,
    vans: vans.rows,
    custodians: custodians.rows,
    atms: atms.rows,
    engineers: engineers.rows,
  };
}

module.exports = { loadReference };
