const { parseSwitchFile } = require('../lib/switchFile');

async function importSwitchContent(client, { filename, content, replaceExisting }) {
  const todayRes = await client.query('SELECT CURRENT_DATE::text AS today');
  const today = todayRes.rows[0].today;
  const parsed = parseSwitchFile(content, { today });
  if (parsed.fileError) return { ok: false, fileError: parsed.fileError };
  if (!parsed.rows.length) {
    return { ok: false, fileError: 'The file has no transaction rows.' };
  }

  const codes = [...new Set(parsed.rows.filter((row) => !row.error && row.atmCode).map((row) => row.atmCode))];
  const codeMap = new Map();
  if (codes.length) {
    const found = await client.query(
      'SELECT atm_id, atm_code FROM atms WHERE atm_code = ANY($1::text[])',
      [codes]
    );
    for (const row of found.rows) codeMap.set(row.atm_code, row.atm_id);
  }

  for (const row of parsed.rows) {
    if (!row.error && row.atmCode && !codeMap.has(row.atmCode)) {
      row.error = `Unknown ATM code ${row.atmCode}.`;
    }
  }

  const ready = parsed.rows.filter((row) => !row.error);
  if (!replaceExisting && ready.length) {
    const existing = await client.query(
      `SELECT a.atm_code, to_char(w.withdrawal_date, 'YYYY-MM-DD') AS withdrawal_date
       FROM daily_withdrawals w
       JOIN atms a ON a.atm_id = w.atm_id
       WHERE (w.atm_id, w.withdrawal_date) IN (
         SELECT * FROM UNNEST($1::int[], $2::date[])
       )`,
      [ready.map((row) => codeMap.get(row.atmCode)), ready.map((row) => row.txnDate)]
    );
    const taken = new Set(existing.rows.map((row) => `${row.atm_code}|${row.withdrawal_date}`));
    for (const row of ready) {
      if (taken.has(`${row.atmCode}|${row.txnDate}`)) {
        row.error = 'A withdrawal total already exists for this ATM and date. Tick replace to overwrite it.';
      }
    }
  }

  const batch = await client.query(
    `INSERT INTO switch_import_batches
       (filename, file_format, row_count, loaded_count, error_count, replace_existing, status)
     VALUES ($1, $2, $3, 0, 0, $4, 'rejected')
     RETURNING batch_id`,
    [safeName(filename), parsed.format, parsed.rows.length, Boolean(replaceExisting)]
  );
  const batchId = batch.rows[0].batch_id;

  await client.query(
    `INSERT INTO switch_import_rows
       (batch_id, line_no, raw_line, atm_code, txn_date, amount, txn_count, status, error_message)
     SELECT $1, x.line_no, x.raw_line, NULLIF(x.atm_code, ''), NULLIF(x.txn_date, '')::date, x.amount, x.txn_count, x.status, NULLIF(x.error_message, '')
     FROM UNNEST(
       $2::int[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::int[], $8::text[], $9::text[]
     ) AS x(line_no, raw_line, atm_code, txn_date, amount, txn_count, status, error_message)`,
    [
      batchId,
      parsed.rows.map((row) => row.lineNo),
      parsed.rows.map((row) => row.raw.slice(0, 2000)),
      parsed.rows.map((row) => row.atmCode || ''),
      parsed.rows.map((row) => row.txnDate || ''),
      parsed.rows.map((row) => (row.amount == null ? null : row.amount)),
      parsed.rows.map((row) => (row.txnCount == null ? null : row.txnCount)),
      parsed.rows.map((row) => (row.error ? 'error' : 'staged')),
      parsed.rows.map((row) => row.error || ''),
    ]
  );

  if (replaceExisting) {
    await client.query(
      `INSERT INTO daily_withdrawals (atm_id, withdrawal_date, amount, txn_count, source)
       SELECT a.atm_id, s.txn_date, s.amount, s.txn_count, 'switch'
       FROM switch_import_rows s
       JOIN atms a ON a.atm_code = s.atm_code
       WHERE s.batch_id = $1 AND s.status = 'staged'
       ON CONFLICT (atm_id, withdrawal_date)
       DO UPDATE SET amount = EXCLUDED.amount, txn_count = EXCLUDED.txn_count, source = 'switch'`,
      [batchId]
    );
  } else {
    await client.query(
      `INSERT INTO daily_withdrawals (atm_id, withdrawal_date, amount, txn_count, source)
       SELECT a.atm_id, s.txn_date, s.amount, s.txn_count, 'switch'
       FROM switch_import_rows s
       JOIN atms a ON a.atm_code = s.atm_code
       WHERE s.batch_id = $1 AND s.status = 'staged'`,
      [batchId]
    );
  }

  await client.query(
    `UPDATE switch_import_rows s
     SET status = 'loaded'
     WHERE s.batch_id = $1
       AND s.status = 'staged'
       AND EXISTS (
         SELECT 1
         FROM daily_withdrawals w
         JOIN atms a ON a.atm_id = w.atm_id
         WHERE a.atm_code = s.atm_code
           AND w.withdrawal_date = s.txn_date
       )`,
    [batchId]
  );
  await client.query(
    `UPDATE switch_import_rows
     SET status = 'error',
         error_message = 'Row was staged but not posted to the withdrawal ledger.'
     WHERE batch_id = $1 AND status = 'staged'`,
    [batchId]
  );

  const counts = await client.query(
    `SELECT
       COUNT(*)::int AS row_count,
       COUNT(*) FILTER (WHERE status = 'loaded')::int AS loaded_count,
       COUNT(*) FILTER (WHERE status = 'error')::int AS error_count
     FROM switch_import_rows
     WHERE batch_id = $1`,
    [batchId]
  );
  const { row_count: rowCount, loaded_count: loaded, error_count: errors } = counts.rows[0];
  let status = 'loaded';
  if (loaded === 0) status = 'rejected';
  else if (errors > 0) status = 'loaded_with_errors';
  await client.query(
    `UPDATE switch_import_batches
     SET row_count = $2, loaded_count = $3, error_count = $4, status = $5
     WHERE batch_id = $1`,
    [batchId, rowCount, loaded, errors, status]
  );

  return { ok: true, batchId, loaded, errors, rowCount, status, format: parsed.format };
}

function safeName(filename) {
  const base = String(filename || 'pasted.csv').split(/[/\\]/).pop().slice(0, 200);
  return base || 'switch-file.csv';
}

module.exports = { importSwitchContent };
