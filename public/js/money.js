/* Shared cassette arithmetic for the replenishment form and the server. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) root.CashMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function lineAmount(denomination, noteCount) {
    const d = Number(denomination);
    const n = Number(noteCount);
    if (!Number.isFinite(d) || !Number.isFinite(n)) return 0;
    return Math.round(d * n * 100) / 100;
  }

  function totalLoaded(lines) {
    const list = Array.isArray(lines) ? lines : [];
    const sum = list.reduce((total, line) => {
      const notes = line && (line.noteCount ?? line.note_count);
      const denom = line && line.denomination;
      return total + lineAmount(denom, notes);
    }, 0);
    return Math.round(sum * 100) / 100;
  }

  return { lineAmount, totalLoaded };
});
