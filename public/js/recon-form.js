(function () {
  const expected = document.getElementById('expected_amount');
  const counted = document.getElementById('counted_amount');
  const diff = document.getElementById('difference');
  const hint = document.getElementById('difference-hint');
  if (!expected || !counted || !diff) return;

  const money = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  });

  function update() {
    if (expected.value === '' || counted.value === '') {
      diff.textContent = '—';
      diff.classList.remove('bad-num');
      if (hint) hint.hidden = true;
      return;
    }
    const gap = Math.round((Number(counted.value) - Number(expected.value)) * 100) / 100;
    if (!Number.isFinite(gap)) {
      diff.textContent = '—';
      return;
    }
    diff.textContent = money.format(gap);
    diff.classList.toggle('bad-num', gap !== 0);
    if (hint) hint.hidden = gap === 0;
  }

  expected.addEventListener('input', update);
  counted.addEventListener('input', update);
  update();
})();
