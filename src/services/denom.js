const DEFAULT_MIX = [
  { denomination: 500, share: 0.5 },
  { denomination: 200, share: 0.3 },
  { denomination: 100, share: 0.2 },
];

function mixFromHistory(rows) {
  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  if (total <= 0) return DEFAULT_MIX.map((row) => ({ ...row }));
  return rows.map((row) => ({
    denomination: Number(row.denomination),
    share: Number(row.amount) / total,
  }));
}

function suggestNotes({ gap, cassettes, mix }) {
  const shares = new Map((mix || DEFAULT_MIX).map((row) => [Number(row.denomination), Number(row.share)]));
  const known = cassettes.reduce((sum, row) => sum + (shares.get(Number(row.denomination)) || 0), 0);
  return cassettes.map((row) => {
    const denom = Number(row.denomination);
    const capacity = Number(row.capacityNotes);
    const share = known > 0 ? (shares.get(denom) || 0) / known : 0;
    const raw = gap > 0 && denom > 0 ? Math.round((Number(gap) * share) / denom) : 0;
    const notes = Math.max(0, Math.min(capacity, raw));
    return { denomination: denom, capacityNotes: capacity, notes, amount: notes * denom };
  });
}

async function loadSuggestion(db, atmId) {
  const [atm, cassettes, history, forecast] = await Promise.all([
    db.query('SELECT atm_code, current_cash FROM atms WHERE atm_id = $1', [atmId]),
    db.query(
      `SELECT denomination, capacity_notes FROM atm_cassettes WHERE atm_id = $1 ORDER BY denomination DESC`,
      [atmId]
    ),
    db.query(
      `SELECT denomination, SUM(amount) AS amount FROM cassette_loads WHERE atm_id = $1 GROUP BY denomination`,
      [atmId]
    ),
    db.query('SELECT forecast_cash($1, CURRENT_DATE + 1) AS forecast', [atmId]),
  ]);
  if (!atm.rowCount) return null;
  const forecastAmount = Number(forecast.rows[0].forecast);
  const gap = Math.max(0, Math.round((forecastAmount - Number(atm.rows[0].current_cash)) * 100) / 100);
  const notes = suggestNotes({
    gap,
    cassettes: cassettes.rows.map((row) => ({
      denomination: Number(row.denomination),
      capacityNotes: Number(row.capacity_notes),
    })),
    mix: mixFromHistory(history.rows),
  });
  return { atmCode: atm.rows[0].atm_code, gap, forecast: forecastAmount, notes };
}

module.exports = { DEFAULT_MIX, mixFromHistory, suggestNotes, loadSuggestion };
