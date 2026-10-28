const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROUNDS = 10;

function hashPassword(password) {
  return bcrypt.hash(String(password), ROUNDS);
}

function checkPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(String(password), hash);
}

function secretMatch(left, right) {
  const a = crypto.createHash('sha256').update(String(left ?? ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(right ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function passwordHints(password) {
  const hints = [];
  if (String(password || '').length < 12) hints.push('Use at least 12 characters.');
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) hints.push('Mix upper and lower case letters.');
  if (!/\d/.test(password)) hints.push('Add a number.');
  if (!/[^A-Za-z0-9]/.test(password)) hints.push('Add a symbol.');
  return hints;
}

module.exports = { hashPassword, checkPassword, passwordHints, secretMatch };
