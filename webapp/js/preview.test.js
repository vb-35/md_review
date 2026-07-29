#!/usr/bin/env node
const assert = require('assert');

global.App = {
  state: {},
  $: () => null
};

const { resolveProjectImageUrl } = require('./preview.js');

assert.strictEqual(
  resolveProjectImageUrl(
    'images/figure.png',
    'project id',
    'results.md',
    '/md-review/api'
  ),
  '/md-review/api/projects/project%20id/assets/images/figure.png'
);

assert.strictEqual(
  resolveProjectImageUrl(
    '../images/figure one.png?raw=1#panel',
    'project-id',
    'paper/sections/results.md',
    '/api/'
  ),
  '/api/projects/project-id/assets/paper/images/figure%20one.png?raw=1#panel'
);

assert.strictEqual(
  resolveProjectImageUrl(
    './images/figure%20one.png',
    'project-id',
    'results.md',
    '/api'
  ),
  '/api/projects/project-id/assets/images/figure%20one.png'
);

for (const source of [
  'https://example.com/figure.png',
  'data:image/png;base64,abc',
  '/api/projects/project-id/assets/images/figure.png',
  '#figure',
  '../../outside.png',
  'images/bad%2Fpath.png'
]) {
  assert.strictEqual(
    resolveProjectImageUrl(source, 'project-id', 'results.md', '/api'),
    source
  );
}

console.log('PASS: preview project image paths');
