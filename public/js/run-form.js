(function () {
  const form = document.getElementById('run-form');
  if (!form || !window.CashMath) return;

  const dataEl = document.getElementById('ref-data');
  const data = dataEl ? JSON.parse(dataEl.textContent) : { atms: [] };
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

  function filterOptions(select, attr, value) {
    [...select.options].forEach((opt) => {
      if (!opt.value) return;
      const show = !value || opt.getAttribute(attr) === String(value);
      opt.hidden = !show;
      opt.disabled = !show;
    });
    const selected = select.selectedOptions[0];
    if (selected && selected.disabled) select.value = '';
  }

  function applyFilters() {
    const locationId = locationSel.value;
    filterOptions(vanSel, 'data-location', locationId);
    filterOptions(custodianSel, 'data-van', vanSel.value);
    if (!list) return;
    list.replaceChildren();
    data.atms
      .filter((atm) => !locationId || String(atm.locationId) === String(locationId))
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
  locationSel.addEventListener('change', applyFilters);
  vanSel.addEventListener('change', applyFilters);
  form.addEventListener('submit', () => {
    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;
  });

  applyFilters();
  recalc();
})();
