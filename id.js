'use strict';

const { randomBytes } = require('crypto');

/**
 * Generates a RFC-4122 v4 UUID using Node's built-in crypto module.
 * No external dependency required.
 * @returns {string}
 */
function generateId() {
  const b = randomBytes(16);
  // Set version bits (v4)
  b[6] = (b[6] & 0x0f) | 0x40;
  // Set variant bits
  b[8] = (b[8] & 0x3f) | 0x80;
  return [
    b.slice(0, 4).toString('hex'),
    b.slice(4, 6).toString('hex'),
    b.slice(6, 8).toString('hex'),
    b.slice(8, 10).toString('hex'),
    b.slice(10).toString('hex'),
  ].join('-');
}

module.exports = { generateId };
