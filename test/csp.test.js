const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function headersFor(mode) {
  const previous = process.env.CSP_MODE;
  process.env.CSP_MODE = mode;
  const server = await listen(createApp());
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    await response.text();
    return response.headers;
  } finally {
    if (previous === undefined) delete process.env.CSP_MODE;
    else process.env.CSP_MODE = previous;
    await new Promise((resolve) => server.close(resolve));
  }
}

after(() => {
  delete process.env.CSP_MODE;
});

test('CSP_MODE enforce, report-only, and off keep frame protection', async () => {
  const enforce = await headersFor('enforce');
  assert.ok(enforce.get('content-security-policy'));
  assert.equal(enforce.get('content-security-policy-report-only'), null);
  assert.equal(enforce.get('x-frame-options'), 'DENY');

  const report = await headersFor('report-only');
  assert.equal(report.get('content-security-policy'), null);
  assert.ok(report.get('content-security-policy-report-only'));
  assert.equal(report.get('x-frame-options'), 'DENY');

  const off = await headersFor('off');
  assert.equal(off.get('content-security-policy'), null);
  assert.equal(off.get('content-security-policy-report-only'), null);
  assert.equal(off.get('x-frame-options'), 'DENY');
});
