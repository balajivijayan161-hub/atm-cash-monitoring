(function () {
  const form = document.getElementById('run-form');
  if (!form || !window.CashMath) return;

  const dataEl = document.getElementById('ref-data');
  let raw = [];
  try {
    raw = dataEl ? JSON.parse(dataEl.textContent) : [];
  } catch (err) {
    raw = [];
  }
  const atms = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.atms) ? raw.atms : []);
  const tbody = document.getElementById('load-rows');
  const template = document.getElementById('load-row-template');
  const totalEl = document.getElementById('total-loaded');
  const locationSel = document.getElementById('location_id');
  const vanSel = document.getElementById('van_id');
  const custodianSel = document.getElementById('custodian_id');
  const list = document.getElementById('atm-codes');

  const money = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  });

  function formatInr(value) {
    return money.format(Number(value) || 0);
  }

  function snapshot(select) {
    if (!select) return [];
    return [...select.options].filter((opt) => opt.value).map((opt) => ({
      value: opt.value,
      label: opt.textContent,
      location: opt.getAttribute('data-location') || '',
      van: opt.getAttribute('data-van') || '',
    }));
  }

  const vans = snapshot(vanSel);
  const custodians = snapshot(custodianSel);

  function refill(select, rows, selected) {
    if (!select) return;
    const keep = rows.some((row) => row.value === selected) ? selected : '';
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose';
    select.appendChild(placeholder);
    rows.forEach((row) => {
      const opt = document.createElement('option');
      opt.value = row.value;
      opt.textContent = row.label;
      if (row.location) opt.setAttribute('data-location', row.location);
      if (row.van) opt.setAttribute('data-van', row.van);
      select.appendChild(opt);
    });
    select.value = keep;
  }

  function recalc() {
    const lines = [...tbody.querySelectorAll('tr')].map((row) => ({
      denomination: row.querySelector('[name="denomination"]').value,
      noteCount: row.querySelector('[name="note_count"]').value,
    }));
    totalEl.textContent = formatInr(window.CashMath.totalLoaded(lines));
    tbody.querySelectorAll('tr').forEach((row) => {
      const amount = window.CashMath.lineAmount(
        row.querySelector('[name="denomination"]').value,
        row.querySelector('[name="note_count"]').value
      );
      row.querySelector('.line-amount').textContent = formatInr(amount);
    });
  }

  function applyFilters() {
    const locationId = locationSel ? locationSel.value : '';
    const vanRows = vans.filter((van) => !locationId || van.location === String(locationId));
    refill(vanSel, vanRows, vanSel ? vanSel.value : '');
    const vanId = vanSel ? vanSel.value : '';
    const custodianRows = custodians.filter((person) => {
      if (vanId) return person.van === String(vanId);
      return !locationId || person.location === String(locationId);
    });
    refill(custodianSel, custodianRows, custodianSel ? custodianSel.value : '');
    if (!list) return;
    list.replaceChildren();
    atms
      .filter((atm) => atm && (!locationId || String(atm.locationId) === String(locationId)))
      .forEach((atm) => {
        const opt = document.createElement('option');
        opt.value = atm.code;
        opt.textContent = atm.label;
        list.appendChild(opt);
      });
  }

  document.getElementById('add-load').addEventListener('click', () => {
    tbody.appendChild(template.content.cloneNode(true));
    recalc();
  });

  tbody.addEventListener('click', (event) => {
    const button = event.target.closest('.remove-row');
    if (!button) return;
    const rows = tbody.querySelectorAll('tr');
    if (rows.length === 1) {
      rows[0].querySelector('[name="atm_code"]').value = '';
      rows[0].querySelector('[name="note_count"]').value = '';
    } else {
      button.closest('tr').remove();
    }
    recalc();
  });

  tbody.addEventListener('input', recalc);
  tbody.addEventListener('change', recalc);
  if (locationSel) locationSel.addEventListener('change', applyFilters);
  if (vanSel) vanSel.addEventListener('change', applyFilters);
  form.addEventListener('submit', () => {
    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;
  });

  applyFilters();
  recalc();
})();
