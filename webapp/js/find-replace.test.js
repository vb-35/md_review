#!/usr/bin/env node
const assert = require('assert');
const {
  findMatches,
  getActiveMatchIndex,
  replaceAllMatches,
  replaceMatch
} = require('./find-replace.js');

const matches = findMatches('alpha beta alpha beta', 'beta');
assert.deepStrictEqual(matches, [
  { start: 6, end: 10 },
  { start: 17, end: 21 }
]);

assert.strictEqual(getActiveMatchIndex(matches, 0, 'forward'), 0);
assert.strictEqual(getActiveMatchIndex(matches, 12, 'forward'), 1);
assert.strictEqual(getActiveMatchIndex(matches, 12, 'backward'), 0);

assert.strictEqual(
  replaceMatch('alpha beta gamma', { start: 6, end: 10 }, 'delta'),
  'alpha delta gamma'
);

assert.deepStrictEqual(
  replaceAllMatches('foo bar foo', 'foo', 'baz'),
  { text: 'baz bar baz', count: 2 }
);

assert.deepStrictEqual(
  replaceAllMatches('foo bar', 'qux', 'baz'),
  { text: 'foo bar', count: 0 }
);

console.log('PASS: find-replace helpers');
