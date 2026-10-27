const { query } = require('../db');

async function loadReference() {
  const [locations, vans, custodians, atms, engineers] = await Promise.all([
    query(`SELECT location_id, location_code, location_name, city, region
           FROM locations ORDER BY location_name`),
    query(`SELECT van_id, van_code, location_id, registration_no, status
           FROM cash_vans ORDER BY van_code`),
    query(`SELECT custodian_id, full_name, van_id, employee_code
           FROM custodians WHERE active ORDER BY full_name`),
    query(`SELECT a.atm_id, a.atm_code, a.site_name, a.status, a.current_cash, b.location_id, b.branch_name, l.location_name
           FROM atms a
           JOIN branches b ON b.branch_id = a.branch_id
           JOIN locations l ON l.location_id = b.location_id
           ORDER BY a.atm_code`),
    query(`SELECT engineer_id, full_name, location_id, specialty
           FROM engineers WHERE active ORDER BY full_name`),
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
