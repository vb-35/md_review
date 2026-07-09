#!/usr/bin/env node
const assert = require('assert');
const {
  getThreadLatestActivityTimestamp,
  isGlobalThread,
  getThreadStartLine,
  sortThreads
} = require('./comments.js');

const olderThread = {
  id: 'thread-older',
  createdAt: '2026-01-01T10:00:00Z',
  comments: [
    { createdAt: '2026-01-03T09:00:00Z' }
  ],
  anchor: { startLine: 20 }
};

const newerCreatedThread = {
  id: 'thread-newer',
  createdAt: '2026-01-02T10:00:00Z',
  comments: [],
  anchor: { startLine: 10 }
};

assert.strictEqual(
  getThreadLatestActivityTimestamp(olderThread),
  Date.parse('2026-01-03T09:00:00Z')
);
assert.strictEqual(isGlobalThread(olderThread), false);
assert.strictEqual(getThreadStartLine(olderThread), 20);
assert.strictEqual(isGlobalThread({ id: 'no-anchor' }), true);
assert.strictEqual(getThreadStartLine({ id: 'no-anchor' }), Number.POSITIVE_INFINITY);

assert.deepStrictEqual(
  sortThreads([olderThread, newerCreatedThread], 'activity-desc').map((thread) => thread.id),
  ['thread-older', 'thread-newer']
);

assert.deepStrictEqual(
  sortThreads([olderThread, newerCreatedThread], 'activity-asc').map((thread) => thread.id),
  ['thread-newer', 'thread-older']
);

const lineThreadA = {
  id: 'line-a',
  createdAt: '2026-01-02T08:00:00Z',
  comments: [],
  anchor: { startLine: 8 }
};
const lineThreadB = {
  id: 'line-b',
  createdAt: '2026-01-02T09:00:00Z',
  comments: [],
  anchor: { startLine: 12 }
};
const unanchoredThread = {
  id: 'no-anchor',
  createdAt: '2026-01-04T10:00:00Z',
  comments: []
};

assert.deepStrictEqual(
  sortThreads([lineThreadB, unanchoredThread, lineThreadA], 'line-asc').map((thread) => thread.id),
  ['no-anchor', 'line-a', 'line-b']
);

const equalDateLineHigh = {
  id: 'line-high',
  createdAt: '2026-01-05T10:00:00Z',
  comments: [],
  anchor: { startLine: 30 }
};
const equalDateLineLow = {
  id: 'line-low',
  createdAt: '2026-01-05T10:00:00Z',
  comments: [],
  anchor: { startLine: 5 }
};

assert.deepStrictEqual(
  sortThreads([equalDateLineHigh, equalDateLineLow], 'activity-desc').map((thread) => thread.id),
  ['line-low', 'line-high']
);

const sameLineOlder = {
  id: 'same-line-older',
  createdAt: '2026-01-01T10:00:00Z',
  comments: [],
  anchor: { startLine: 4 }
};
const sameLineNewer = {
  id: 'same-line-newer',
  createdAt: '2026-01-03T10:00:00Z',
  comments: [],
  anchor: { startLine: 4 }
};

assert.deepStrictEqual(
  sortThreads([sameLineOlder, sameLineNewer], 'line-asc').map((thread) => thread.id),
  ['same-line-newer', 'same-line-older']
);

console.log('PASS: comments sorting helpers');
