#!/usr/bin/env node
const assert = require('assert');

global.App = {
  state: {},
  $: () => null
};

const {
  findSourceLineForRenderedText,
  findTextInSourceRegion,
  lineMatchesRenderedText,
  preprocessMath,
  resolveProjectImageUrl
} = require('./preview.js');

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

const repeatedParagraphs = [
  'Repeated paragraph text.',
  '',
  'A paragraph in between.',
  '',
  'Repeated paragraph text.'
];
assert.strictEqual(
  findSourceLineForRenderedText(repeatedParagraphs, 'Repeated paragraph text.', 0),
  0
);
assert.strictEqual(
  findSourceLineForRenderedText(repeatedParagraphs, 'Repeated paragraph text.', 1),
  4
);
assert.strictEqual(
  lineMatchesRenderedText('A **formatted** paragraph.', 'A formatted paragraph.'),
  true
);
assert.strictEqual(
  findSourceLineForRenderedText(repeatedParagraphs, 'Missing paragraph.', 0),
  -1
);

const mathSource = 'Before $x^2$ and $$y = 3$$ after.';
const processedMath = preprocessMath(mathSource, 4, 100);
assert(processedMath.includes('{MATHI:0}'));
assert(processedMath.includes('{MATHB:1}'));
assert.deepStrictEqual(global.App.state.mathPlaceholders['{MATHI:0}'], {
  type: 'inline',
  math: 'x^2',
  line: 5,
  sourceStart: 107,
  sourceEnd: 112
});
assert.deepStrictEqual(global.App.state.mathPlaceholders['{MATHB:1}'], {
  type: 'block',
  math: 'y = 3',
  line: 5,
  sourceStart: 117,
  sourceEnd: 126
});
assert.deepStrictEqual(
  findTextInSourceRegion('Repeated before $x$ before', 'before', 0, 20, true),
  { start: 9, end: 15 }
);

console.log('PASS: preview project image paths');
