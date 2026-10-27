const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('archive_ej_logs.sh compresses journals and purges old days', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ej-'));
  const source = path.join(root, 'ej');
  const archive = path.join(root, 'archive');
  const atm = path.join(source, 'ATM-MUM-0001');
  fs.mkdirSync(atm, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(atm, '2020-01-15.ej'), 'old journal\n');
  fs.writeFileSync(path.join(atm, `${today}.log`), 'recent journal\n');

  execFileSync('bash', [
    path.join(__dirname, '..', 'scripts', 'archive_ej_logs.sh'),
    '--source', source,
    '--archive', archive,
    '--retain-days', '30',
  ], { encoding: 'utf8' });

  const kept = path.join(archive, today, 'ATM-MUM-0001', `${today}.log.gz`);
  assert.equal(fs.existsSync(kept), true);
  assert.equal(fs.existsSync(path.join(archive, '2020-01-15')), false);
  assert.equal(fs.existsSync(path.join(atm, `${today}.log`)), false);
  const log = fs.readFileSync(path.join(archive, 'archive.log'), 'utf8');
  assert.match(log, /ARCHIVE/);
  assert.match(log, /PURGE/);
});
