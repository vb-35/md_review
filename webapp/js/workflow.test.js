// Run with node webapp/js/workflow.test.js; no browser or test dependencies needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const nodes = new Map();
function node(selector) {
  if (!nodes.has(selector)) nodes.set(selector, {
    textContent: '', innerHTML: '', disabled: false, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, callback) { this[type] = callback; },
    appendChild(child) { child.parent = this; },
    querySelectorAll() { return []; },
    setAttribute() {},
  });
  return nodes.get(selector);
}
const storage = new Map();
const context = vm.createContext({
  console, Date, setTimeout, clearTimeout, clearInterval() {},
  setInterval(callback) { context.heartbeat = callback; return 1; },
  localStorage: {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  },
  document: { querySelector: node, createElement: () => node('created') },
  location: { pathname: '/' },
  confirm: () => true,
});
context.window = context;
function load(file) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
}
load('app.js');
const { state, helpers } = context.App;
let content = '';
context.App.editor = { getValue: () => content, setValue: value => { content = value; }, setEditable() {} };
context.App.preview = { updatePreview() {} };
const file = () => ({ filePath: 'one.md', content: 'original', currentCommitSha: 'base' });
state.currentUser = { id: 'owner' };
state.currentProject = { id: 'project', accessRole: 'owner', lockOwnerId: 'owner', lockExpiresAt: '2099-01-01' };
state.currentFile = file();

(async () => {
  content = 'my draft';
  helpers.markEditorChanged();
  const key = [...storage.keys()][0];
  assert.equal(JSON.parse(storage.get(key)).content, content);
  context.confirm = () => false;
  assert.equal(helpers.confirmLeaveEditor(), false);
  context.confirm = () => true;
  assert.equal(helpers.confirmLeaveEditor(), true);

  // Recovery keeps the original revision even when someone else has saved newer text.
  state.currentFile = { ...file(), content: 'newer text', currentCommitSha: 'newer' };
  content = 'newer text';
  helpers.restoreDraft();
  assert.equal(content, 'my draft');
  assert.equal(state.currentFile.currentCommitSha, 'base');
  state.currentUser = { id: 'other-user' };
  content = 'other user text';
  helpers.restoreDraft();
  assert.equal(content, 'other user text');
  state.currentUser = { id: 'owner' };
  content = 'my draft';

  context.fetch = async () => { throw new Error('offline'); };
  helpers.updateHeader();
  await context.heartbeat();
  assert.equal(content, 'my draft');
  assert.equal(helpers.holdsCurrentLock(), false);
  assert.match(node('#save-status').textContent, /Lock refresh failed/);

  await helpers.saveCurrentFile();
  assert.equal(content, 'my draft');
  assert.match(node('#save-status').textContent, /Save failed: offline/);
  assert.equal(state.saving, false);
  assert.equal(JSON.parse(storage.get(key)).content, 'my draft');

  // Typing while a save is in flight must remain unsaved, with a fresh recovery draft.
  let finish;
  context.fetch = () => new Promise(resolve => { finish = resolve; });
  context.App.projects.refreshProjectState = async () => {};
  const saving = helpers.saveCurrentFile();
  assert.equal(helpers.confirmLeaveEditor(), false);
  content = 'typed during save';
  helpers.markEditorChanged();
  finish({ ok: true, headers: { get: () => 'application/json' },
    json: async () => ({ ...file(), content: 'my draft', currentCommitSha: 'saved' }) });
  await saving;
  assert.equal(content, 'typed during save');
  assert.equal(state.editing, true);
  assert.equal(JSON.parse(storage.get(key)).baseCommitSha, 'saved');

  // Persisted proposal decisions are not treated as a disposable manual draft.
  state.activeProposalReview = { projectedContent: content };
  state.comparedDiffBaselineContent = state.currentFile.content;
  helpers.persistDraft();
  assert.equal(helpers.hasUnsavedChanges(), false);
  assert.equal(storage.has(key), false);
  content += ' manual edit';
  helpers.markEditorChanged();
  assert.equal(helpers.hasUnsavedChanges(), true);
  context.localStorage.setItem = () => { throw new Error('quota'); };
  assert.equal(helpers.persistDraft(), false);
  assert.match(node('#save-status').textContent, /recovery unavailable/);

  // The same proposal controls move into the editor, including progress and comment actions.
  helpers.esc = value => String(value || '');
  load('proposals.js');
  state.currentView = 'editor';
  state.currentProject.lockExpiresAt = '2099-01-01';
  state.currentProposal = {
    id: 'proposal', title: 'Review', status: 'pending', authorId: 'owner',
    authorUsername: 'owner', baseCommitSha: 'base',
    review: { required: 2, decided: 1, canClose: false },
    files: [{ filePath: 'one.md', diff: [], reviewItems: [{ decision: 'accept' }] }],
    commentActions: [{ id: 'comment', filePath: 'one.md', actionType: 'reply', body: 'Done' }],
  };
  context.App.proposals.renderProposalDetail();
  assert.equal(node('#proposal-review').parent, node('#editor-proposal-host'));
  assert.match(node('#proposal-review').innerHTML, /1 decisions remaining/);
  assert.match(node('#proposal-review').innerHTML, /data-proposal-file="one.md"/);
  assert.match(node('#proposal-review').innerHTML, /Comment actions/);
  assert.match(node('#proposal-review').innerHTML, /id="btn-close-proposal-review" class="primary" disabled/);
  state.currentProposal.review.canClose = true;
  context.App.proposals.renderProposalDetail();
  assert.match(node('#proposal-review').innerHTML, /id="btn-close-proposal-review" class="primary">/);
  state.currentView = 'dashboard';
  context.App.proposals.renderProposalDetail();
  assert.equal(node('#proposal-review').parent, node('#dashboard-proposal-host'));
  console.log('PASS: draft recovery, save races, lock failure, and unified proposal controls');
})().catch(error => { console.error(error); process.exitCode = 1; });
