const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage, intOrNull, isIsoDate } = require('../http');
const { loadReference } = require('../services/reference');

const router = express.Router();
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekdayName(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

router.get('/forecast', asyncRoute(async (req, res) => {
  const ref = await loadReference();
  const dates = await query(`SELECT CURRENT_DATE::text AS today, (CURRENT_DATE + 1)::text AS tomorrow`);
  const atmId = intOrNull(req.query.atm_id);
  const targetDate = typeof req.query.date === 'string' ? req.query.date : dates.rows[0].tomorrow;
  let result = null;
  let error = '';
  if (req.query.atm_id || req.query.date) {
    if (!atmId) error = 'Choose an ATM.';
    else if (!isIsoDate(targetDate)) error = 'Choose a valid date.';
    else {
      const [forecast, points, atm] = await Promise.all([
        query('SELECT forecast_cash($1, $2::date) AS forecast', [atmId, targetDate]),
        query('SELECT withdrawal_date::text AS withdrawal_date, amount, txn_count FROM forecast_cash_points($1, $2::date)', [atmId, targetDate]),
        query(
          `SELECT a.atm_id, a.atm_code, a.site_name, a.current_cash, a.capacity_amount, a.status, l.location_name
           FROM atms a
           JOIN branches b ON b.branch_id = a.branch_id
           JOIN locations l ON l.location_id = b.location_id
           WHERE a.atm_id = $1`,
          [atmId]
        ),
      ]);
      if (!atm.rowCount) error = 'That ATM is not on the ledger.';
      else {
        const forecastAmount = Number(forecast.rows[0].forecast);
        const current = Number(atm.rows[0].current_cash);
        result = {
          atm: atm.rows[0],
          forecast: forecastAmount,
          points: points.rows,
          weekday: weekdayName(targetDate),
          shortfall: Math.max(0, Math.round((forecastAmount - current) * 100) / 100),
          covered: current >= forecastAmount,
        };
      }
    }
  }
  const groups = ref.locations.map((location) => ({
    ...location,
    atms: ref.atms.filter((atm) => atm.location_id === location.location_id),
  }));
  renderPage(req, res, 'forecast', {
    title: 'Cash forecast',
    groups,
    targetDate,
    atmId: atmId || '',
    result,
    error,
    today: dates.rows[0].today,
  });
}));

module.exports = router;
