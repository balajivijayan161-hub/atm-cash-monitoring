(function () {
  const dataEl = document.getElementById('dashboard-charts');
  if (dataEl && typeof Chart !== 'undefined') {
    let charts = {};
    try {
      charts = JSON.parse(dataEl.textContent);
    } catch (err) {
      charts = {};
    }
    Chart.defaults.font.family = 'Outfit, sans-serif';
    Chart.defaults.color = '#5e574c';
    const brass = '#8d6a3a';
    const ink = '#1b2421';
    const clay = '#8d2f2f';
    const sized = { responsive: true, maintainAspectRatio: false };
    new Chart(document.getElementById('uptime-chart'), {
      type: 'bar',
      data: { labels: charts.locations, datasets: [{ label: 'Uptime %', data: charts.uptime, backgroundColor: ink, borderRadius: 4 }] },
      options: { ...sized, plugins: { legend: { display: false } }, scales: { y: { min: 80, max: 100 } } },
    });
    new Chart(document.getElementById('day-chart'), {
      type: 'line',
      data: { labels: charts.days, datasets: [{ label: 'Minutes', data: charts.downtimeMinutes, borderColor: clay, backgroundColor: 'rgba(141,47,47,0.12)', fill: true, tension: 0.25 }] },
      options: { ...sized, plugins: { legend: { display: false } } },
    });
    new Chart(document.getElementById('weekday-chart'), {
      type: 'bar',
      data: {
        labels: charts.weekdays,
        datasets: [{
          label: 'Dispensed',
          data: charts.weekdayAmounts,
          backgroundColor: charts.weekdays.map((day) => (day === 'Fri' || day === 'Sat' || day === 'Sun' ? brass : '#cfc3ae')),
          borderRadius: 4,
        }],
      },
      options: { ...sized, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        ['uptime-chart', 'day-chart', 'weekday-chart'].forEach((id) => {
          const chart = Chart.getChart(id);
          if (chart) chart.resize();
        });
      });
    }
  }

  let seen = null;
  setInterval(async () => {
    try {
      const body = await fetch('/live-feed/status').then((res) => res.json());
      if (seen && seen.running && (!body.running || body.ticks !== seen.ticks)) {
        location.reload();
        return;
      }
      seen = body;
    } catch (err) { /* leave the page as it is */ }
  }, 5000);
}());
