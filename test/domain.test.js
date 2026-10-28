const { test } = require('node:test');
const assert = require('node:assert/strict');
const { forecastFactor, mape } = require('../src/services/calendar');
const { mixFromHistory, suggestNotes } = require('../src/services/denom');
const { slaCategory, slaBreach } = require('../src/services/sla');
const { caseChangeError } = require('../src/services/reconCase');

test('calendar factors lift salary days, month-end, and holidays', () => {
  assert.equal(forecastFactor('2026-10-15', 1), 1);
  assert.equal(forecastFactor('2026-10-02', 1), 1.2);
  assert.equal(forecastFactor('2026-10-30', 1), 1.2);
  assert.equal(forecastFactor('2026-10-31', 1), 1.38);
  assert.equal(forecastFactor('2026-11-08', 1.8), 1.8);
  assert.equal(mape([{ forecast: 110, actual: 100 }, { forecast: 90, actual: 100 }]), 10);
  assert.equal(mape([{ forecast: 10, actual: 0 }]), null);
});

test('note suggestions follow the mix and cassette capacity', () => {
  const mix = mixFromHistory([{ denomination: 500, amount: 5000 }, { denomination: 100, amount: 5000 }]);
  const notes = suggestNotes({
    gap: 10000,
    cassettes: [
      { denomination: 500, capacityNotes: 4 },
      { denomination: 100, capacityNotes: 100 },
    ],
    mix,
  });
  assert.equal(notes[0].notes, 4);
  assert.equal(notes[0].amount, 2000);
  assert.equal(notes[1].notes, 50);
  assert.equal(notes[1].amount, 5000);
});

test('SLA breaches and variance transitions follow the rules', () => {
  assert.equal(slaCategory('communication'), 'network');
  assert.equal(slaCategory('cash_variance'), 'other');
  const opened = new Date('2026-10-28T00:00:00+05:30');
  const late = slaBreach({
    openedAt: opened,
    respondedAt: null,
    closedAt: null,
    now: new Date('2026-10-28T06:00:00+05:30'),
    responseHours: 4,
    resolutionHours: 8,
  });
  assert.equal(late.responseBreach, true);
  assert.equal(late.resolutionBreach, false);
  assert.equal(caseChangeError({ from: 'raised', to: 'resolved', canApprove: true, reason: 'other' }), 'That status change is not allowed.');
  assert.equal(caseChangeError({ from: 'investigating', to: 'resolved', canApprove: false, reason: 'other' }), 'A branch or regional manager has to approve the resolution.');
  assert.equal(caseChangeError({ from: 'investigating', to: 'written_off', canApprove: true, reason: 'fraud_suspected' }), null);
});
