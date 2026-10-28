function monthLength(iso) {
  const [year, month] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function forecastFactor(iso, holidayMultiplier = 1) {
  const day = Number(String(iso).slice(8, 10));
  const last = monthLength(iso);
  let factor = 1;
  if (day <= 3 || day > last - 2) factor *= 1.2;
  if (day === last) factor *= 1.15;
  const holiday = Number(holidayMultiplier);
  if (holiday > 1) factor *= holiday;
  return Math.round(factor * 100) / 100;
}

function mape(pairs) {
  const usable = pairs.filter((row) => Number(row.actual) > 0);
  if (!usable.length) return null;
  const total = usable.reduce((sum, row) => {
    return sum + Math.abs(Number(row.forecast) - Number(row.actual)) / Number(row.actual);
  }, 0);
  return Math.round((total / usable.length) * 10000) / 100;
}

module.exports = { monthLength, forecastFactor, mape };
