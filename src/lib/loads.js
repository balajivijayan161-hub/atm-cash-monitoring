const { asArray } = require('../http');
const { lineAmount, totalLoaded } = require('../../public/js/money');

const DENOMINATIONS = new Set([100, 200, 500, 2000]);

function normalizeLoads(body) {
  const atmCodes = asArray(body.atm_code);
  const cassettes = asArray(body.cassette_number);
  const denoms = asArray(body.denomination);
  const notes = asArray(body.note_count);
  const loadIds = asArray(body.load_id);
  const width = Math.max(atmCodes.length, cassettes.length, denoms.length, notes.length, loadIds.length);
  const errors = [];
  const lines = [];
  const seen = new Set();

  for (let i = 0; i < width; i += 1) {
    const atmCode = String(atmCodes[i] || '').trim().toUpperCase();
    const cassetteRaw = cassettes[i];
    const denomRaw = denoms[i];
    const noteRaw = notes[i];
    const loadRaw = loadIds[i];
    const blank = !atmCode
      && (cassetteRaw === undefined || cassetteRaw === '')
      && (noteRaw === undefined || noteRaw === '')
      && (denomRaw === undefined || denomRaw === '');
    if (blank) continue;

    const row = i + 1;
    const cassette = Number(cassetteRaw);
    const denomination = Number(denomRaw);
    const noteCount = Number(noteRaw);
    const loadId = loadRaw ? Number(loadRaw) : null;
    let rowOk = true;

    if (!atmCode) {
      errors.push(`Row ${row}: enter an ATM code.`);
      rowOk = false;
    }
    if (!Number.isInteger(cassette) || cassette < 1 || cassette > 4) {
      errors.push(`Row ${row}: cassette must be 1, 2, 3, or 4.`);
      rowOk = false;
    }
    if (!DENOMINATIONS.has(denomination)) {
      errors.push(`Row ${row}: denomination must be 100, 200, 500, or 2000.`);
      rowOk = false;
    }
    if (!Number.isInteger(noteCount) || noteCount <= 0 || noteCount > 10000) {
      errors.push(`Row ${row}: note count must be a whole number from 1 to 10000.`);
      rowOk = false;
    }
    if (atmCode && Number.isInteger(cassette)) {
      const key = `${atmCode}:${cassette}`;
      if (seen.has(key)) {
        errors.push(`Row ${row}: cassette ${cassette} is already listed for ${atmCode}.`);
        rowOk = false;
      }
      seen.add(key);
    }

    lines.push({
      loadId: Number.isInteger(loadId) ? loadId : null,
      atmCode,
      cassette: Number.isInteger(cassette) ? cassette : cassetteRaw,
      denomination: DENOMINATIONS.has(denomination) ? denomination : denomRaw,
      noteCount: Number.isInteger(noteCount) ? noteCount : noteRaw,
      amount: rowOk ? lineAmount(denomination, noteCount) : 0,
    });
  }

  if (!lines.length) errors.push('Add at least one cassette load.');

  return { lines, errors, total: totalLoaded(lines.filter((line) => line.amount > 0)) };
}

module.exports = { normalizeLoads, DENOMINATIONS };
