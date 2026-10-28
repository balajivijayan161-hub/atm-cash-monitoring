const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { withTransaction } = require('../db');
const { importSwitchContent } = require('./switchImport');

const FILE_RE = /\.(csv|txt|dat)$/i;

function inboundConfig(overrides = {}) {
  return {
    inboundDir: overrides.inboundDir || process.env.SWITCH_INBOUND_DIR || path.join('data', 'inbound'),
    processedDir: overrides.processedDir || process.env.SWITCH_PROCESSED_DIR || path.join('data', 'processed'),
    rejectedDir: overrides.rejectedDir || process.env.SWITCH_REJECTED_DIR || path.join('data', 'rejected'),
    pollMs: overrides.pollMs ?? (Number(process.env.SWITCH_POLL_MS) || 5 * 60 * 1000),
  };
}

function classifyIngestResult(result) {
  if (result && result.duplicate) return 'processed';
  if (!result || result.ok === false || !result.loaded) return 'rejected';
  return 'processed';
}

async function moveUnique(from, directory, name) {
  await fs.mkdir(directory, { recursive: true });
  let dest = path.join(directory, name);
  try {
    await fs.access(dest);
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    dest = path.join(directory, `${base}-${Date.now()}${ext}`);
  } catch (err) {
    /* destination is free */
  }
  try {
    await fs.rename(from, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.copyFile(from, dest);
    await fs.unlink(from);
  }
  return dest;
}

async function recordRejected(client, { filename, content, message, source }) {
  const hash = crypto.createHash('sha256').update(String(content)).digest('hex');
  const batch = await client.query(
    `INSERT INTO switch_import_batches
       (filename, file_format, row_count, loaded_count, error_count, replace_existing, status, source, content_sha256)
     VALUES ($1, 'csv', 1, 0, 1, FALSE, 'rejected', $2, $3)
     RETURNING batch_id`,
    [String(filename || 'switch-file.csv').split(/[/\\]/).pop().slice(0, 200), source, hash]
  );
  const batchId = batch.rows[0].batch_id;
  await client.query(
    `INSERT INTO switch_import_rows
       (batch_id, line_no, raw_line, status, error_message)
     VALUES ($1, 1, $2, 'error', $3)`,
    [batchId, String(content || '').slice(0, 2000), message]
  );
  await client.query(
    `INSERT INTO inbound_files (filename, content_sha256, source, batch_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (content_sha256) DO NOTHING`,
    [filename, hash, source, batchId]
  );
  return { ok: false, loaded: 0, errors: 1, batchId, hash, fileError: message };
}

async function ingestTracked(client, { filename, content, source = 'schedule', replaceExisting = false, rules } = {}) {
  const hash = crypto.createHash('sha256').update(String(content)).digest('hex');
  const seen = await client.query(
    'SELECT batch_id FROM inbound_files WHERE content_sha256 = $1',
    [hash]
  );
  if (seen.rowCount) {
    return { ok: true, duplicate: true, batchId: seen.rows[0].batch_id, loaded: 0, hash };
  }
  const result = await importSwitchContent(client, {
    filename,
    content,
    replaceExisting,
    source,
    contentSha256: hash,
    rules,
  });
  if (!result.ok) {
    const rejected = await recordRejected(client, {
      filename,
      content,
      message: result.fileError || 'The file could not be read.',
      source,
    });
    return { ...rejected, duplicate: false };
  }
  await client.query(
    `INSERT INTO inbound_files (filename, content_sha256, source, batch_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (content_sha256) DO NOTHING`,
    [filename, hash, source, result.batchId]
  );
  return { ...result, duplicate: false, hash };
}

async function scanInboundOnce(overrides = {}) {
  const config = inboundConfig(overrides);
  await fs.mkdir(config.inboundDir, { recursive: true });
  await fs.mkdir(config.processedDir, { recursive: true });
  await fs.mkdir(config.rejectedDir, { recursive: true });
  const names = await fs.readdir(config.inboundDir);
  const outcomes = [];
  for (const name of names) {
    if (!FILE_RE.test(name) || name.startsWith('.')) continue;
    const full = path.join(config.inboundDir, name);
    const stat = await fs.stat(full);
    if (!stat.isFile()) continue;
    const content = await fs.readFile(full, 'utf8');
    let result;
    try {
      result = await withTransaction((client) => ingestTracked(client, {
        filename: name,
        content,
        source: 'schedule',
        replaceExisting: false,
        rules: overrides.rules,
      }));
    } catch (err) {
      console.error(`Switch inbound file ${name} failed`, err);
      outcomes.push({ name, error: err.message });
      continue;
    }
    const bucket = classifyIngestResult(result);
    const destDir = bucket === 'rejected' ? config.rejectedDir : config.processedDir;
    await moveUnique(full, destDir, name);
    outcomes.push({ name, bucket, batchId: result.batchId, duplicate: Boolean(result.duplicate) });
  }
  return outcomes;
}

let timer = null;
let scanning = false;

function startInboundPoller(overrides = {}) {
  const config = inboundConfig(overrides);
  if (!config.pollMs || config.pollMs < 0) return null;
  stopInboundPoller();
  const tick = async () => {
    if (scanning) return;
    scanning = true;
    try {
      await scanInboundOnce(overrides);
    } catch (err) {
      console.error('Switch inbound scan failed', err);
    } finally {
      scanning = false;
    }
  };
  timer = setInterval(tick, config.pollMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function stopInboundPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  inboundConfig,
  classifyIngestResult,
  ingestTracked,
  scanInboundOnce,
  startInboundPoller,
  stopInboundPoller,
};
