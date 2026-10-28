function slaCategory(value) {
  if (value === 'cash_out') return 'cash_out';
  if (value === 'hardware') return 'hardware';
  if (value === 'communication') return 'network';
  if (value === 'power') return 'power';
  return 'other';
}

function hoursBetween(start, end) {
  const opened = start instanceof Date ? start.getTime() : new Date(start).getTime();
  const closed = end instanceof Date ? end.getTime() : new Date(end).getTime();
  if (!Number.isFinite(opened) || !Number.isFinite(closed)) return null;
  return (closed - opened) / 3600000;
}

function slaBreach({ openedAt, respondedAt, closedAt, now, responseHours, resolutionHours }) {
  const responsePoint = respondedAt || now;
  const resolutionPoint = closedAt || now;
  const response = hoursBetween(openedAt, responsePoint);
  const resolution = hoursBetween(openedAt, resolutionPoint);
  return {
    responseHours: response == null ? null : Math.round(response * 10) / 10,
    resolutionHours: resolution == null ? null : Math.round(resolution * 10) / 10,
    responseBreach: response != null && response > Number(responseHours),
    resolutionBreach: resolution != null && resolution > Number(resolutionHours),
  };
}

module.exports = { slaCategory, hoursBetween, slaBreach };
