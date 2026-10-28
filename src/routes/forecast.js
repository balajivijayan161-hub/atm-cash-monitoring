const express = require('express');
const { query } = require('../db');
const { asyncRoute, renderPage, intOrNull, isIsoDate } = require('../http');
const { deny, guard } = require('../auth/gate');
const { scopeBinds, atmScopeSql } = require('../auth/permissions');
const { recordChange } = require('../auth/activity');
const { loadReference } = require('../services/reference');
const { loadSuggestion } = require('../services/denom');
const { mape } = require('../services/calendar');

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
      if (!atm.rowCount) error = 'That ATM was not found.';
      else {
        const allowed = await query(
          `SELECT 1 FROM atms a WHERE a.atm_id = $1 AND a.atm_id IN (${atmScopeSql(2)})`,
          [atmId, ...scopeBinds(req.user)]
        );
        if (!allowed.rowCount) return deny(req, res);
        const forecastAmount = Number(forecast.rows[0].forecast);
        const current = Number(atm.rows[0].current_cash);
        const factor = await query('SELECT forecast_multiplier($1::date) AS factor', [targetDate]);
        const suggestion = await loadSuggestion({ query }, atmId);
        result = {
          atm: atm.rows[0],
          forecast: forecastAmount,
          points: points.rows,
          weekday: weekdayName(targetDate),
          factor: Number(factor.rows[0].factor),
          shortfall: Math.max(0, Math.round((forecastAmount - current) * 100) / 100),
          covered: current >= forecastAmount,
          suggestion,
        };
      }
    }
  }
  const groups = ref.locations.map((location) => ({
    ...location,
    atms: ref.atms.filter((atm) => atm.location_id === location.location_id),
  }));
  renderPage(req, res, 'forecast', {
    title: 'Cash Forecast',
    groups,
    targetDate,
    atmId: atmId || '',
    result,
    error,
    today: dates.rows[0].today,
    canEditCalendar: req.user.role === 'super_admin',
  });
}));

router.get('/forecast/accuracy', asyncRoute(async (req, res) => {
  const windowDays = req.query.window === '28' ? 28 : 7;
  const atmId = intOrNull(req.query.atm_id);
  const ref = await loadReference();
  let rows = [];
  let errorPct = null;
  let chart = { labels: [], forecast: [], actual: [] };
  if (atmId) {
    const series = await query(
      `SELECT day::date::text AS day,
              forecast_cash($1, day::date) AS forecast,
              COALESCE((SELECT amount FROM daily_withdrawals w
                        WHERE w.atm_id = $1 AND w.withdrawal_date = day::date), 0) AS actual
       FROM generate_series(CURRENT_DATE - $2::int, CURRENT_DATE - 1, interval '1 day') AS day
       ORDER BY day`,
      [atmId, windowDays]
    );
    rows = series.rows.map((row) => ({
      ...row,
      error: Number(row.actual) > 0
        ? Math.round((Math.abs(Number(row.forecast) - Number(row.actual)) / Number(row.actual)) * 10000) / 100
        : null,
    }));
    errorPct = mape(rows.map((row) => ({ forecast: row.forecast, actual: row.actual })));
    chart = {
      labels: rows.map((row) => row.day.slice(5)),
      forecast: rows.map((row) => Number(row.forecast)),
      actual: rows.map((row) => Number(row.actual)),
    };
  }
  renderPage(req, res, 'forecast-accuracy', {
    title: 'Forecast Accuracy',
    atms: ref.atms,
    atmId: atmId || '',
    windowDays,
    rows,
    errorPct,
    chart,
  });
}));

router.get('/forecast/calendar', asyncRoute(async (req, res) => {
  if (req.user.role !== 'super_admin') return deny(req, res);
  const rows = await query(
    `SELECT holiday_id, holiday_date::text AS holiday_date, name, multiplier, active
     FROM holidays ORDER BY holiday_date`
  );
  renderPage(req, res, 'holiday-calendar', { title: 'Holiday Calendar', rows: rows.rows, errors: [] });
}));

router.post('/forecast/calendar', asyncRoute(async (req, res) => {
  if (req.user.role !== 'super_admin') return deny(req, res);
  const date = typeof req.body.holiday_date === 'string' ? req.body.holiday_date : '';
  const name = String(req.body.name || '').trim().slice(0, 80);
  const multiplier = Number(req.body.multiplier);
  const errors = [];
  if (!isIsoDate(date)) errors.push('Choose a valid date.');
  if (!name) errors.push('Enter the holiday name.');
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 5) errors.push('Multiplier must be between 0 and 5.');
  if (errors.length) {
    const rows = await query(
      `SELECT holiday_id, holiday_date::text AS holiday_date, name, multiplier, active FROM holidays ORDER BY holiday_date`
    );
    return renderPage(req, res, 'holiday-calendar', { title: 'Holiday Calendar', rows: rows.rows, errors, statusCode: 400 });
  }
  const saved = await query(
    `INSERT INTO holidays (holiday_date, name, multiplier, active)
     VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (holiday_date) DO UPDATE
       SET name = EXCLUDED.name, multiplier = EXCLUDED.multiplier, active = TRUE
     RETURNING holiday_id`,
    [date, name, multiplier]
  );
  await recordChange(req, {
    action: 'update',
    entity: 'holiday',
    entityId: saved.rows[0].holiday_id,
    before: null,
    after: { holiday_date: date, name, multiplier },
  });
  res.redirect('/forecast/calendar?notice=Holiday saved.');
}));

module.exports = guard(router, 'forecast');
