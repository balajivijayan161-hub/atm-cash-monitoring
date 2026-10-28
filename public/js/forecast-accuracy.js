(function () {
  const dataEl = document.getElementById('accuracy-data');
  const canvas = document.getElementById('accuracy-chart');
  if (!dataEl || !canvas || typeof Chart === 'undefined') return;
  let chart = {};
  try {
    chart = JSON.parse(dataEl.textContent);
  } catch (err) {
    return;
  }
  new Chart(canvas, {
    type: 'line',
    data: {
      labels: chart.labels,
      datasets: [
        { label: 'Forecast', data: chart.forecast, borderColor: '#8d6a3a', tension: 0.2 },
        { label: 'Actual', data: chart.actual, borderColor: '#1e4d5c', tension: 0.2 },
      ],
    },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
  });
}());
