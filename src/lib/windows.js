function lastEightWeeks(column) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(column)) {
    throw new Error('Invalid date column');
  }
  return `${column} > CURRENT_DATE - 56 AND ${column} <= CURRENT_DATE`;
}

module.exports = { lastEightWeeks };
