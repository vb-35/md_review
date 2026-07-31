const assert = require('assert');
const { buildPreviewAnnotations, decisionKey, renderTrackedSource } = require('./review-main.js');

const replacementRemoved = {
  rowId: 'row-1',
  type: 'removed',
  line: 'alpha beta and old',
  baseLine: 2,
  candLine: 2,
  pairRowId: 'row-2',
  chunks: []
};
const replacementAdded = {
  rowId: 'row-2',
  type: 'added',
  line: 'alpha gamma and new',
  baseLine: 2,
  candLine: 2,
  pairRowId: 'row-1',
  segments: [
    { text: 'alpha ', changed: false },
    { text: 'gamma', changed: true, chunkId: 'chunk-a' },
    { text: ' and ', changed: false },
    { text: 'new', changed: true, chunkId: 'chunk-b' }
  ],
  chunks: [
    { chunkId: 'chunk-a', kind: 'replace', baseText: 'beta', candText: 'gamma' },
    { chunkId: 'chunk-b', kind: 'replace', baseText: 'old', candText: 'new' }
  ]
};
const diff = [
  {
    rowId: 'row-0',
    type: 'context',
    line: '<heading>',
    baseLine: 1,
    candLine: 1,
    segments: []
  },
  replacementRemoved,
  replacementAdded,
  {
    rowId: 'row-3',
    type: 'removed',
    line: 'deleted line',
    baseLine: 3,
    chunks: [{ chunkId: 'chunk-c', kind: 'line-remove' }]
  },
  {
    rowId: 'row-4',
    type: 'added',
    line: '',
    candLine: 3,
    chunks: [{ chunkId: 'chunk-d', kind: 'line-add' }]
  }
];

assert.strictEqual(decisionKey('row-2', 'chunk-a'), 'row-2::chunk-a');

const enabled = renderTrackedSource(
  diff,
  { 'row-2::chunk-a': 'accept', 'row-3::chunk-c': 'refuse' },
  true,
  { base: 'v1', candidate: 'v2' }
);
assert.strictEqual((enabled.match(/review-source-replacement/g) || []).length, 1);
assert.ok(enabled.includes('<del class="review-removed">beta</del>'));
assert.ok(enabled.includes('<ins class="review-added">gamma</ins>'));
assert.ok(enabled.includes('data-review-accept-line="row-2"'));
assert.ok(enabled.includes('diff-action accept active'));
assert.ok(enabled.includes('diff-action refuse active'));
assert.ok(enabled.includes('&lt;heading&gt;'));
assert.ok(enabled.includes('&nbsp;'));
assert.ok(!enabled.includes('data-review-action="accept" data-review-row-id="row-1"'));

const disabled = renderTrackedSource(diff, {}, false);
assert.ok(disabled.includes('data-review-chunk-id="chunk-a" disabled'));
assert.ok(disabled.includes('data-review-accept-line="row-2"'));

const annotations = buildPreviewAnnotations(diff);
assert.strictEqual(annotations.filter((item) => item.kind === 'replace').length, 2);
assert.deepStrictEqual(
  annotations.filter((item) => item.kind === 'replace').map((item) => [item.removedText, item.addedText]),
  [['beta', 'gamma'], ['old', 'new']]
);
assert.strictEqual(annotations.find((item) => item.kind === 'remove').candidateLine, 3);
assert.strictEqual(annotations.find((item) => item.kind === 'add').addedText, '');

console.log('PASS: main review tracked source helpers');
