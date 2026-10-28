const FIXED_LENGTH = 42;

function parseSwitchFile(content, options = {}) {
  const today = options.today || null;
  const text = String(content || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = text.split('\n');
  const meaningful = rawLines
    .map((line, index) => ({ lineNo: index + 1, raw: line }))
    .filter((entry) => entry.raw.trim() !== '');

  if (!meaningful.length) {
    return { format: null, rows: [], fileError: 'The upload is empty.' };
  }

  const format = meaningful[0].raw.includes(',') ? 'csv' : 'fixed';
  const rows = format === 'csv'
    ? parseCsv(meaningful, today)
    : meaningful.map((entry) => parseFixed(entry, today));

  markFileDuplicates(rows);
  return { format, rows, fileError: null };
}

function parseCsv(entries, today) {
  const header = splitCsv(entries[0].raw).map((cell) => cell.toLowerCase());
  const required = ['atm_code', 'txn_date', 'amount', 'txn_count'];
  if (!required.every((name) => header.includes(name))) {
    return [{
      lineNo: entries[0].lineNo,
      raw: entries[0].raw,
      atmCode: null,
      txnDate: null,
      amount: null,
      txnCount: null,
      error: 'The first row must name the ATM, date, amount, and transaction count.',
    }];
  }
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  return entries.slice(1).map((entry) => {
    const cells = splitCsv(entry.raw);
    const row = buildRow({
      lineNo: entry.lineNo,
      raw: entry.raw,
      atmCode: cells[index.atm_code] || '',
      dateRaw: cells[index.txn_date] || '',
      amountRaw: cells[index.amount] || '',
      countRaw: cells[index.txn_count] || '',
      dateStyle: 'iso',
      today,
    });
    if (Object.prototype.hasOwnProperty.call(index, 'cash_level')) {
      const cash = parseCashLevel(cells[index.cash_level] || '');
      if (cash.error) addProblem(row, cash.error);
      else row.cashLevel = cash.value;
    }
    if (Object.prototype.hasOwnProperty.call(index, 'fault_code')) {
      const fault = parseFaultCode(cells[index.fault_code] || '');
      if (fault.error) addProblem(row, fault.error);
      else row.faultCode = fault.value;
    }
    if (Object.prototype.hasOwnProperty.call(index, 'online')) {
      const online = parseOnline(cells[index.online] || '');
      if (online.error) addProblem(row, online.error);
      else row.online = online.value;
    }
    if (row.faultCode === 'offline' && row.online == null) row.online = false;
    return row;
  });
}

function addProblem(row, message) {
  row.error = row.error ? `${row.error} ${message}` : message;
}

const FAULT_CODES = new Set([
  'cash_out',
  'hardware',
  'communication',
  'cassette_error',
  'power',
  'vandalism',
  'offline',
]);

function parseCashLevel(value) {
  const text = String(value || '').trim();
  if (!text) return { value: null };
  if (/^-/.test(text)) return { error: 'Cash level cannot be negative.' };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { error: 'Cash level must be a number with up to 2 decimal places.' };
  return { value: Number(text) };
}

function parseFaultCode(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return { value: null };
  if (!FAULT_CODES.has(text)) return { error: 'Unknown fault.' };
  return { value: text };
}

function parseOnline(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return { value: null };
  if (['1', 'true', 'yes', 'y', 'online', 'up'].includes(text)) return { value: true };
  if (['0', 'false', 'no', 'n', 'offline', 'down'].includes(text)) return { value: false };
  return { error: 'Online flag must be yes or no.' };
}

function parseFixed(entry, today) {
  const line = entry.raw.replace(/\r$/, '');
  if (line.length !== FIXED_LENGTH) {
    return {
      lineNo: entry.lineNo,
      raw: entry.raw,
      atmCode: line.slice(0, 16).trim() || null,
      txnDate: null,
      amount: null,
      txnCount: null,
      error: `This row is not the expected length (it has ${line.length} characters).`,
    };
  }
  return buildRow({
    lineNo: entry.lineNo,
    raw: entry.raw,
    atmCode: line.slice(0, 16).trim(),
    dateRaw: line.slice(16, 24),
    amountRaw: line.slice(24, 36),
    countRaw: line.slice(36, 42),
    dateStyle: 'basic',
    today,
  });
}

function buildRow({ lineNo, raw, atmCode, dateRaw, amountRaw, countRaw, dateStyle, today }) {
  const row = {
    lineNo,
    raw,
    atmCode: atmCode ? String(atmCode).trim().toUpperCase() : null,
    txnDate: null,
    amount: null,
    txnCount: null,
    error: null,
  };
  const problems = [];
  if (!row.atmCode) problems.push('ATM code is missing.');

  const date = dateStyle === 'basic' ? parseBasicDate(dateRaw) : parseIsoDate(dateRaw);
  if (!date) problems.push('Transaction date is not a real calendar date.');
  else if (today && date > today) problems.push('Transaction date is in the future.');
  else row.txnDate = date;

  const amount = parseAmount(amountRaw, dateStyle === 'basic');
  if (amount.error) problems.push(amount.error);
  else row.amount = amount.value;

  const count = parseCount(countRaw, dateStyle === 'basic');
  if (count.error) problems.push(count.error);
  else row.txnCount = count.value;

  if (problems.length) row.error = problems.join(' ');
  return row;
}

function markFileDuplicates(rows) {
  const seen = new Set();
  for (const row of rows) {
    if (row.error || !row.atmCode || !row.txnDate) continue;
    const key = `${row.atmCode}|${row.txnDate}`;
    if (seen.has(key)) {
      row.error = 'Duplicate ATM and date in this file.';
    } else {
      seen.add(key);
    }
  }
}

function parseIsoDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return validDate(text) ? text : null;
}

function parseBasicDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{8}$/.test(text)) return null;
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return validDate(iso) ? iso : null;
}

function validDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function parseAmount(value, fixed) {
  const text = String(value || '').trim();
  if (fixed) {
    if (!/^\d{12}$/.test(text)) return { error: 'Amount must be a 12-digit whole-rupee field.' };
    const n = Number(text);
    if (n > 100000000) return { error: 'Amount exceeds 100,000,000.' };
    return { value: n };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    if (/^-/.test(text)) return { error: 'Amount cannot be negative.' };
    return { error: 'Amount must be a number with up to 2 decimal places.' };
  }
  const n = Number(text);
  if (n > 100000000) return { error: 'Amount exceeds 100,000,000.' };
  return { value: n };
}

function parseCount(value, fixed) {
  const text = String(value || '').trim();
  if (fixed) {
    if (!/^\d{6}$/.test(text)) return { error: 'Transaction count must be a 6-digit field.' };
    const n = Number(text);
    if (n > 1000000) return { error: 'Transaction count exceeds 1,000,000.' };
    return { value: n };
  }
  if (!/^\d+$/.test(text)) return { error: 'Transaction count must be a whole number.' };
  const n = Number(text);
  if (n > 1000000) return { error: 'Transaction count exceeds 1,000,000.' };
  return { value: n };
}

function splitCsv(line) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}

function formatFixedLine({ atmCode, txnDate, amount, txnCount }) {
  const code = String(atmCode).padEnd(16, ' ').slice(0, 16);
  const date = String(txnDate).replace(/-/g, '');
  const amt = String(Math.round(Number(amount))).padStart(12, '0');
  const count = String(Number(txnCount)).padStart(6, '0');
  return `${code}${date}${amt}${count}`;
}

module.exports = {
  FIXED_LENGTH,
  FAULT_CODES,
  parseSwitchFile,
  formatFixedLine,
};
