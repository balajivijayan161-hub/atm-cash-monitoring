function hoursToEmpty(currentCash, dailyForecast) {
  const cash = Number(currentCash);
  const daily = Number(dailyForecast);
  if (!Number.isFinite(cash) || !Number.isFinite(daily) || daily <= 0) return null;
  if (cash <= 0) return 0;
  return Math.round((cash / daily) * 24 * 10) / 10;
}

function runsOutWithinDay(hours) {
  return hours != null && hours <= 24;
}

module.exports = { hoursToEmpty, runsOutWithinDay };
