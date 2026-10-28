const REASONS = ['counting_error', 'dispense_fault', 'fraud_suspected', 'cassette_mismatch', 'other'];

function caseChangeError({ from, to, canApprove, reason }) {
  const next = {
    raised: ['investigating'],
    investigating: ['resolved', 'written_off'],
  };
  if (!next[from] || !next[from].includes(to)) return 'That status change is not allowed.';
  if ((to === 'resolved' || to === 'written_off') && !canApprove) {
    return 'A branch or regional manager has to approve the resolution.';
  }
  if ((to === 'resolved' || to === 'written_off') && !REASONS.includes(reason)) return 'Choose a reason.';
  return null;
}

module.exports = { REASONS, caseChangeError };
