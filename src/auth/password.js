const bcrypt = require('bcryptjs');

const ROUNDS = 10;

function hashPassword(password) {
  return bcrypt.hash(String(password), ROUNDS);
}

function checkPassword(password, hash) {
  return bcrypt.compare(String(password), hash);
}

module.exports = { hashPassword, checkPassword };
