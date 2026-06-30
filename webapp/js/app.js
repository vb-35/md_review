/* ===== API Helpers ===== */
const API = (() => {
  let path = window.location.pathname || '/';
  if (path.endsWith('/index.html')) {
    path = path.slice(0, -'/index.html'.length) || '/';
  }
  if (path === '/' || path === '') return '/api';
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  return `${normalized}/api`;
})();
let headers = () => ({
  'Content-Type': 'application/json',
  ...(currentUser ? { 'X-User-Id': currentUser.id } : {})
});

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: headers(),
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await res.json()
    : { error: `Expected JSON from ${API + path}, got ${contentType || 'non-JSON response'}` };
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ===== State ===== */
let currentUser = null;
let currentDoc = null;
let docs = [];
let versions = [];
let selectedBaseId = null;
let selectedHeadId = null;
let threads = [];
let editing = false;
let showResolved = false;
let authMode = null;
let passwordLoginEnabled = true;

/* ===== DOM ===== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* ===== Auth ===== */
async function login(username, password) {
  try {
    const response = await api('POST', '/auth/login', { username, password });
    currentUser = response.user || response;
    showEditor();
    await loadDocs();
  } catch (e) {
    const err = $('#login-error');
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
}

async function logout() {
  try { await api('POST', '/auth/logout'); } catch {}
  currentUser = null;
  currentDoc = null;
  authMode = null;
  passwordLoginEnabled = true;
  $('#topbar').classList.add('hidden');
  $('#editor-screen').classList.add('hidden');
  $('#doc-sidebar').classList.add('hidden');
  await initAuth();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').classList.add('hidden');
  login($('#login-username').value, $('#login-password').value);
});

$('#btn-logout').addEventListener('click', logout);

/* Init selection listener for inline comments */
initSelectionListener();

/* ===== UI ===== */
function showEditor() {
  $('#login-screen').classList.add('hidden');
  $('#editor-screen').classList.remove('hidden');
  $('#topbar').classList.remove('hidden');
  $('#user-display').textContent = currentUser.username;
}

function showLoginScreen(message = '') {
  const hint = $('#login-hint');
  const form = $('#login-form');
  const error = $('#login-error');

  $('#topbar').classList.add('hidden');
  $('#editor-screen').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');

  if (passwordLoginEnabled) {
    form.classList.remove('hidden');
    if (message) {
      hint.textContent = message;
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
      hint.textContent = '';
    }
  } else {
    form.classList.add('hidden');
    hint.textContent = message || 'Waiting for a trusted upstream user identity.';
    hint.classList.remove('hidden');
  }

  error.classList.add('hidden');
  error.textContent = '';
}

function consumeTokenFromUrl() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (!token) return null;
  url.searchParams.delete('token');
  history.replaceState({}, document.title, url.pathname + url.search + url.hash);
  return token;
}

async function loginWithToken(token) {
  const response = await api('POST', '/auth/token-login', { token });
  authMode = response.authMode || authMode;
  passwordLoginEnabled = response.passwordLoginEnabled !== false;
  return response.user || response;
}

async function bootstrapAuth() {
  const res = await fetch(API + '/auth/bootstrap', {
    method: 'GET',
    headers: headers(),
    credentials: 'include'
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await res.json()
    : { error: `Expected JSON from ${API + '/auth/bootstrap'}, got ${contentType || 'non-JSON response'}` };
  authMode = data.authMode || null;
  passwordLoginEnabled = data.passwordLoginEnabled !== false;
  if (!res.ok) {
    const error = new Error(data.error || 'Authentication bootstrap failed');
    error.authMode = authMode;
    error.passwordLoginEnabled = passwordLoginEnabled;
    throw error;
  }
  return data.user || data;
}

async function initAuth() {
  const loginToken = consumeTokenFromUrl();
  try {
    if (loginToken) {
      currentUser = await loginWithToken(loginToken);
    } else {
      currentUser = await bootstrapAuth();
    }
    showEditor();
    await loadDocs();
  } catch (e) {
    currentUser = null;
    showLoginScreen(e.message);
  }
}

function renderDocList() {
  const ul = $('#doc-list');
  ul.innerHTML = '';
  for (const doc of docs) {
    const li = document.createElement('li');
    if (currentDoc && doc.id === currentDoc.id) li.classList.add('active');
    li.innerHTML = `
      <span>${esc(doc.title)}</span>
      <span class="meta">
        <span>${doc.lockOwnerId ? '\u{1F512}' : ''}</span>
        <button class="delete-btn" data-id="${doc.id}" title="Delete">&times;</button>
      </span>`;
    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('delete-btn')) return;
      openDoc(doc.id);
    });
    li.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this document?')) return;
      await api('DELETE', `/documents/${doc.id}`);
      if (currentDoc && currentDoc.id === doc.id) {
        currentDoc = null;
        $('#editor').value = '';
        $('#doc-title').textContent = '';
        $('#btn-save').disabled = true;
      }
      loadDocs();
    });
    ul.appendChild(li);
  }
}

function toggleSidebar() {
  $('#doc-sidebar').classList.toggle('hidden');
}
$('#btn-menu').addEventListener('click', toggleSidebar);

$('#btn-new-doc').addEventListener('click', async () => {
  const title = prompt('Document title:');
  if (!title) return;
  const doc = await api('POST', '/documents', { title, markdown: `# ${title}\n\n` });
  await loadDocs();
  openDoc(doc.id);
});

/* ===== Documents ===== */
async function loadDocs() {
  docs = await api('GET', '/documents');
  renderDocList();
  $('#doc-sidebar').classList.add('hidden');
}

async function openDoc(id) {
  currentDoc = await api('GET', `/documents/${id}`);
  $('#doc-title').textContent = currentDoc.title;
  $('#editor').value = currentDoc.markdown;
  editing = false;
  updateLockBadge();
  updateLockBtn();
  updateSaveBtn();
  renderPreview();
  loadThreads();
  toggleBtns(true);
  $('#doc-sidebar').classList.add('hidden');
  renderDocList();
}

function updateLockBadge() {
  const badge = $('#lock-badge');
  if (currentDoc.lockOwnerId) {
    badge.textContent = currentDoc.lockOwnerId === currentUser.id ? 'Locked by you' : 'Locked';
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function updateLockBtn() {
  if (!currentDoc) {
    $('#btn-lock').disabled = true;
    return;
  }
  $('#btn-lock').disabled = false;
  if (currentDoc.lockOwnerId === currentUser.id) {
    $('#btn-lock').innerHTML = '\u{1F513} Unlock';
  } else if (currentDoc.lockOwnerId) {
    $('#btn-lock').innerHTML = '\u{1F512} Locked';
    $('#btn-lock').disabled = true;
  } else {
    $('#btn-lock').innerHTML = '\u{1F512} Lock';
  }
}

function toggleBtns(locked) {
  const canEdit = currentDoc && currentDoc.lockOwnerId === currentUser.id;
  $('#btn-save').disabled = !canEdit || !editing;
  // Version history is always available when a doc is open
  $('#btn-review').disabled = !currentDoc;
  updateLockBtn();
}

/* ===== Editor ===== */
const editor = $('#editor');

editor.addEventListener('input', () => {
  if (!editing) editing = true;
  updateSaveBtn();
  debouncePreview();
});

editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
    editor.selectionStart = editor.selectionEnd = start + 4;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveDoc();
  }
});

function updateSaveBtn() {
  const canEdit = currentDoc && currentDoc.lockOwnerId === currentUser.id;
  $('#btn-save').disabled = !canEdit || !editing;
}

let previewTimer;
function debouncePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 300);
}

/* ===== Save ===== */
$('#btn-save').addEventListener('click', saveDoc);

async function saveDoc() {
  if (!currentDoc || currentDoc.lockOwnerId !== currentUser.id) return;
  try {
    currentDoc = await api('PUT', `/documents/${currentDoc.id}`, {
      markdown: editor.value
    });
    editing = false;
    updateSaveBtn();
    renderPreview();
    loadThreads();
  } catch (e) {
    alert('Save failed: ' + e.message);
  }
}

$('#btn-lock').addEventListener('click', toggleLock);

async function toggleLock() {
  if (!currentDoc) return;
  if (currentDoc.lockOwnerId && currentDoc.lockOwnerId === currentUser.id) {
    await unlockDoc();
    $('#btn-lock').innerHTML = '\u{1F512} Lock';
  } else {
    await tryLockDoc();
    $('#btn-lock').innerHTML = '\u{1F513} Unlock';
  }
  toggleBtns(true);
}

/* ===== Lock ===== */
async function tryLock() {
  if (!currentDoc) return;
  if (currentDoc.lockOwnerId && currentDoc.lockOwnerId !== currentUser.id) {
    tryLockDoc();
  }
}

async function tryLockDoc() {
  try {
    currentDoc = await api('POST', `/documents/${currentDoc.id}/lock`);
    updateLockBadge();
    toggleBtns(true);
  } catch (e) {
    if (e.message.includes('locked by another user')) {
      alert('This document is locked by another user.');
    } else {
      throw e;
    }
  }
}

async function unlockDoc() {
  if (!currentDoc) return;
  try {
    await api('DELETE', `/documents/${currentDoc.id}/lock`);
    currentDoc.lockOwnerId = null;
    updateLockBadge();
    toggleBtns(false);
  } catch (e) {
    alert(e.message);
  }
}

/* ===== Preview ===== */
let mathPlaceholders = {};
let placeholderCounter = 0;

function preprocessMath(md) {
  mathPlaceholders = {};
  placeholderCounter = 0;

  // Replace block math $$...$$ first
  md = md.replace(/\$\$([\s\S]+?)\$\$/g, (match, math) => {
    const key = `{MATHB:${placeholderCounter++}}`;
    mathPlaceholders[key] = { type: 'block', math: math.trim() };
    return `\n\n${key}\n\n`;
  });

  // Replace inline math $...$
  md = md.replace(/\$([^\$\n]+?)\$/g, (match, math) => {
    const key = `{MATHI:${placeholderCounter++}}`;
    mathPlaceholders[key] = { type: 'inline', math };
    return ` ${key} `;
  });

  return md;
}

function postprocessMath(html) {
  // Replace raw keys directly in the HTML string
  for (const [key, { type, math }] of Object.entries(mathPlaceholders)) {
    let rendered;
    try {
      rendered = katex.renderToString(math, {
        throwOnError: false,
        displayMode: type === 'block'
      });
    } catch {
      rendered = `<code>${escapeHtml(math)}</code>`;
    }
    const wrapper = type === 'block'
      ? `<div class="math-block">${rendered}</div>`
      : `<span class="math-inline">${rendered}</span>`;
    // Use split+join for reliable replacement
    html = html.split(key).join(wrapper);
  }
  return html;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderPreview() {
  if (!currentDoc) return;
  let md = editor.value || '';
  md = preprocessMath(md);
  const html = marked.parse(md);
  const finalHtml = postprocessMath(html);
  const preview = $('#preview');
  preview.innerHTML = finalHtml;

  // Add data-line attributes to block elements for comment anchoring
  annotateLines(preview, editor.value);

  renderHighlight(preview);
  updateCommentMarkers();
}

/* Map rendered block elements back to source line numbers */
function annotateLines(container, source) {
  const lines = source.split('\n');
  const blockEls = container.querySelectorAll('h1, h2, h3, h4, h5, h6, p, pre, blockquote, li, td, tr, table, ul, ol, div.math-block, hr');

  // Build a text offset -> line number map
  let offset = 0;
  const lineMap = [];
  for (let i = 0; i < lines.length; i++) {
    lineMap.push({ line: i + 1, offset: offset });
    offset += lines[i].length + 1;
  }

  function offsetToLine(off) {
    for (let i = lineMap.length - 1; i >= 0; i--) {
      if (off >= lineMap[i].offset) return lineMap[i].line;
    }
    return 1;
  }

  // Walk text nodes to build offset tracking
  let textOffset = 0;
  const textNodes = [];
  function walkTextNodes(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        textNodes.push({ offset: textOffset, len: node.textContent.length });
        textOffset += node.textContent.length;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        walkTextNodes(node);
      }
    }
  }
  walkTextNodes(container);

  // For each block element, find the first text node inside it to estimate its source line
  // Then wrap it with a data-line attribute
  const processed = new Set();
  for (const el of blockEls) {
    if (processed.has(el)) continue;

    // Find the first text node in this element
    let firstTextOffset = -1;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let tn;
    while ((tn = walker.nextNode())) {
      const content = tn.textContent.trim();
      if (content) {
        // Search for this text in the source to find its line
        const searchText = content.substring(0, 50);
        if (searchText.length > 5) {
          const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escaped);
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              firstTextOffset = i + 1;
              break;
            }
          }
        }
        break;
      }
    }

    if (firstTextOffset > 0) {
      el.setAttribute('data-line', firstTextOffset);
    }
    processed.add(el);
  }
}

/* Show comment markers (yellow indicators) next to lines with anchored comments */
function updateCommentMarkers() {
  const preview = $('#preview');
  // Remove existing markers
  preview.querySelectorAll('.comment-indicator').forEach(m => m.remove());

  if (!threads || threads.length === 0) return;

  for (const thread of threads) {
    if (!thread.anchor || thread.resolved) continue;
    const { startLine, endLine } = thread.anchor;

    // Find elements with matching data-line
    const targets = preview.querySelectorAll(`[data-line="${startLine}"]`);
    for (const el of targets) {
      const indicator = document.createElement('span');
      indicator.className = 'comment-indicator';
      indicator.title = `${thread.comments.length} comment${thread.comments.length !== 1 ? 's' : ''}`;
      indicator.textContent = '\u2764';
      indicator.addEventListener('click', (e) => {
        e.stopPropagation();
        openThreadInPanel(thread.id);
      });
      // Insert at the beginning of the element
      el.style.position = 'relative';
      el.prepend(indicator);
    }
  }
}

/* Click handler for text selection in preview to create anchored comment */
function initSelectionListener() {
  const preview = $('#preview');
  let selectionTimeout;

  preview.addEventListener('mouseup', () => {
    clearTimeout(selectionTimeout);
    selectionTimeout = setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;

      const range = selection.getRangeAt(0);
      if (!preview.contains(range.commonAncestorContainer)) return;

      const text = selection.toString().trim();
      if (!text || text.length < 2) return;

      // Find the line number of the selection
      const line = findLineFromSelection(range);
      if (!line) return;

      // Show a small floating prompt
      showCommentPrompt(range, line);
    }, 200);
  });
}

function findLineFromSelection(range) {
  const node = range.startContainer;
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;

  // Try to find data-line on an ancestor
  while (el && el !== $('#preview')) {
    if (el.hasAttribute && el.hasAttribute('data-line')) {
      return parseInt(el.getAttribute('data-line'));
    }
    el = el.parentElement;
  }
  return null;
}

function showCommentPrompt(range, line) {
  // Remove any existing prompt
  const existing = document.querySelector('.selection-comment-prompt');
  if (existing) existing.remove();

  const rect = range.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.className = 'selection-comment-prompt';
  popup.innerHTML = `<button>Add comment</button>`;
  popup.style.cssText = `
    position: fixed;
    left: ${rect.left}px;
    top: ${rect.top - 36}px;
    z-index: 200;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
  `;

  const btn = popup.querySelector('button');
  btn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    popup.remove();
    const body = window.prompt('Enter your comment:');
    if (!body || !body.trim()) return;

    // Capture the selected text content
    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : '';

    try {
      await api('POST', '/comments/threads', {
        documentId: currentDoc.id,
        body: body.trim(),
        anchor: { startLine: line, endLine: line, selectedText: selectedText }
      });
      await loadThreads();
      updateCommentMarkers();
    } catch (e) {
      alert('Failed to create thread: ' + e.message);
    }
  });

  document.body.appendChild(popup);

  // Auto-remove on click outside
  const dismissHandler = (e) => {
    if (!popup.isConnected) return;
    if (!popup.contains(e.target)) {
      popup.remove();
      document.removeEventListener('mousedown', dismissHandler);
    }
  };
  document.addEventListener('mousedown', dismissHandler);
}

/* Open a specific thread in the comments panel, scrolling to it and highlighting the text */
function openThreadInPanel(threadId) {
  $('#comments-panel').classList.remove('hidden');
  loadThreads().then(() => {
    const threadEl = document.querySelector(`.thread[data-thread-id="${threadId}"]`);
    if (threadEl) {
      threadEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      threadEl.style.outline = '2px solid var(--accent)';
      setTimeout(() => { threadEl.style.outline = ''; }, 2000);
    }

    // Highlight the text in the preview
    highlightThreadInPreview(threadId);
  });
}

function highlightThreadInPreview(threadId) {
  const thread = threads.find(t => t.id === threadId);
  if (!thread) return;

  // Remove previous highlights
  document.querySelectorAll('.thread-text-highlight').forEach(el => {
    el.classList.remove('thread-text-highlight');
  });

  const preview = $('#preview');

  // If we have selected text, try to find and select it
  if (thread.anchor && thread.anchor.selectedText) {
    const textToFind = thread.anchor.selectedText.trim();
    if (textToFind.length > 2) {
      const textWalker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, null);
      let textNode;
      while ((textNode = textWalker.nextNode())) {
        if (textNode.textContent.trim() === textToFind) {
          const range = document.createRange();
          range.selectNodeContents(textNode.parentElement || textNode);
          const parent = textNode.parentElement || textNode.parentNode;

          // Find the closest block element with data-line
          let target = parent;
          while (target && target !== preview) {
            if (target.hasAttribute && target.hasAttribute('data-line')) {
              target.classList.add('thread-text-highlight');
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });

              // Create a selection within the text node
              const sel = window.getSelection();
              const nodeRange = document.createRange();
              nodeRange.selectNodeContents(textNode);
              sel.removeAllRanges();
              sel.addRange(nodeRange);

              setTimeout(() => {
                target.classList.remove('thread-text-highlight');
                sel.removeAllRanges();
              }, 3000);
              return;
            }
            target = target.parentElement;
          }
          break;
        }
      }
    }
  }

  // Fallback: find by line number
  if (thread.anchor && thread.anchor.startLine) {
    const target = preview.querySelector(`[data-line="${thread.anchor.startLine}"]`);
    if (target) {
      target.classList.add('thread-text-highlight');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => { target.classList.remove('thread-text-highlight'); }, 3000);
    }
  }
}

function renderMath(container) {
  // Kept for backward compatibility, but main math rendering is now done via preprocess/postprocess
  container.querySelectorAll('.math-inline').forEach((el) => {
    try {
      el.outerHTML = katex.renderToString(el.textContent, { throwOnError: false, displayMode: false });
    } catch {}
  });
  container.querySelectorAll('.math-block').forEach((el) => {
    try {
      el.outerHTML = katex.renderToString(el.textContent, { throwOnError: false, displayMode: true });
    } catch {}
  });
}

function renderHighlight(container) {
  container.querySelectorAll('pre code').forEach((block) => {
    try {
      hljs.highlightElement(block);
    } catch {}
  });
}

/* Configure marked */
marked.setOptions({
  breaks: true,
  gfm: true,
  headerIds: false,
  mangle: false
});

/* ===== Version History Panel ===== */
$('#btn-review').addEventListener('click', () => {
  $('#review-panel').classList.remove('hidden');
  selectedBaseId = null;
  selectedHeadId = null;
  loadVersions();
});
$('#btn-close-review').addEventListener('click', () => $('#review-panel').classList.add('hidden'));

async function loadVersions() {
  if (!currentDoc) return;
  try {
    versions = await api('GET', `/documents/${currentDoc.id}/versions`);
    renderVersionSelects();
  } catch (e) {
    console.error(e);
  }
}

function renderVersionSelects() {
  const baseSel = $('#version-select-base');
  const headSel = $('#version-select-head');
  baseSel.innerHTML = '<option value="">Base version...</option>';
  headSel.innerHTML = '<option value="">Head version...</option>';
  for (const v of versions) {
    const label = `v${v.version} — ${esc(v.message)} (${new Date(v.created_at).toLocaleString()})`;
    baseSel.innerHTML += `<option value="${v.id}">${label}</option>`;
    headSel.innerHTML += `<option value="${v.id}">${label}</option>`;
  }
  // Pre-select: latest as base, second latest as head
  if (versions.length >= 2) {
    baseSel.value = versions[0].id;
    headSel.value = versions[1].id;
    selectedBaseId = versions[0].id;
    selectedHeadId = versions[1].id;
  } else if (versions.length === 1) {
    baseSel.value = versions[0].id;
    selectedBaseId = versions[0].id;
  }
}

$('#btn-select-base').addEventListener('click', () => {
  selectedBaseId = $('#version-select-base').value;
});

$('#btn-select-head').addEventListener('click', () => {
  selectedHeadId = $('#version-select-head').value;
});

$('#btn-compare').addEventListener('click', async () => {
  selectedBaseId = $('#version-select-base').value;
  selectedHeadId = $('#version-select-head').value;

  if (!selectedBaseId || !selectedHeadId) {
    alert('Select both base and head versions.');
    return;
  }

  try {
    const result = await api('POST', '/versions', {
      documentId: currentDoc.id,
      versionA: selectedBaseId,
      versionB: selectedHeadId
    });
    renderDiff(result.diff);
    $('#version-diff-actions').classList.remove('hidden');
    $('#version-diff-actions').style.display = 'flex';
    $('#diff-meta').textContent = `v${result.versionA} → v${result.versionB}`;
    $('#btn-revert').dataset.versionId = selectedHeadId;
    $('#btn-revert').disabled = false;
  } catch (e) {
    alert('Diff failed: ' + e.message);
  }
});

$('#btn-revert').addEventListener('click', async () => {
  const verId = $('#btn-revert').dataset.versionId;
  if (!verId) return;
  if (!confirm('Revert document to this version? This will create a new version.')) return;
  try {
    const result = await api('POST', `/versions/${verId}/revert`);
    // Reload doc
    currentDoc = await api('GET', `/documents/${currentDoc.id}`);
    editor.value = currentDoc.markdown;
    editing = false;
    updateSaveBtn();
    renderPreview();
    loadThreads();
    // Reload versions
    await loadVersions();
    $('#diff-view').innerHTML = '<p style="padding:20px;color:var(--green);text-align:center;">Reverted to v' + result.version + '</p>';
  } catch (e) {
    alert('Revert failed: ' + e.message);
  }
});

function renderDiff(lines) {
  let html = '';
  let hunkIdx = 0;
  let inHunk = false;

  for (const line of lines) {
    const isChange = line.type === 'added' || line.type === 'removed';
    if (isChange) {
      if (!inHunk) {
        inHunk = true;
        html += `<div class="diff-hunk" data-hunk="${hunkIdx}">`;
      }
      const cls = line.type === 'added' ? 'added' : 'removed';
      const prefix = line.type === 'added' ? '+' : '-';
      html += `<div class="diff-line ${cls}" data-prefix="${prefix}">${esc(line.line)}</div>`;
    } else {
      if (inHunk) {
        html += `</div>`;
        inHunk = false;
        hunkIdx++;
      }
      html += `<div class="diff-line context" data-prefix=" ">${esc(line.line)}</div>`;
    }
  }
  if (inHunk) html += `</div>`;

  if (!html) {
    html = '<p style="padding:20px;color:var(--fg-dim);text-align:center;">No differences</p>';
  }

  $('#diff-view').innerHTML = html;
}

/* ===== Comments Panel ===== */
$('#btn-threads').addEventListener('click', () => {
  $('#comments-panel').classList.remove('hidden');
  loadThreads();
});
$('#btn-close-comments').addEventListener('click', () => $('#comments-panel').classList.add('hidden'));

async function loadThreads() {
  if (!currentDoc) return;
  try {
    threads = await api('GET', `/documents/${currentDoc.id}/threads`);
    renderThreads();
  } catch (e) {
    console.error('Failed to load threads:', e);
    alert('Failed to load threads. Make sure the server is restarted.');
  }
}

function renderThreads() {
  const container = $('#thread-list');
  container.innerHTML = '';

  const visibleThreads = threads.filter(t => showResolved || !t.resolved);

  if (threads.length === 0) {
    container.innerHTML = '<p style="color:var(--fg-dim);text-align:center;padding:20px;">No comments yet</p>';
    return;
  }

  if (visibleThreads.length === 0) {
    container.innerHTML = '<p style="color:var(--fg-dim);text-align:center;padding:20px;">All comments resolved</p>';
    return;
  }

  for (const thread of visibleThreads) {
    const div = document.createElement('div');
    div.className = 'thread' + (thread.resolved ? ' thread-resolved' : '');
    div.setAttribute('data-thread-id', thread.id);
    div.style.cursor = 'pointer';

    // Clicking the thread highlights the text in preview
    div.addEventListener('click', (e) => {
      if (e.target.closest('.btn-resolve') || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      openThreadInPanel(thread.id);
    });

    let metaHtml = `
      <div class="thread-meta">
        <span class="author">${esc(thread.createdByUsername || '?')}</span>
        <span class="time">${new Date(thread.createdAt).toLocaleString()}</span>
        <button class="btn-resolve" data-thread-id="${thread.id}" title="${thread.resolved ? 'Unresolve' : 'Resolve'}">${thread.resolved ? '\u21BB Unresolve' : '\u2713 Resolve'}</button>
      </div>`;

    if (thread.anchor) {
      metaHtml += `<div class="anchor-info">Lines ${thread.anchor.startLine}–${thread.anchor.endLine}</div>`;
    }

    if (thread.resolved) {
      const resolvedInfo = thread.resolvedBy || thread.resolvedAt
        ? `<div class="resolved-badge">Resolved${thread.resolvedAt ? ' on ' + new Date(thread.resolvedAt).toLocaleDateString() : ''}</div>`
        : '<div class="resolved-badge">Resolved</div>';
      metaHtml += resolvedInfo;
    }

    let commentsHtml = '';
    for (const c of (thread.comments || [])) {
      commentsHtml += `
        <div class="comment">
          <div class="comment-author">${esc(c.username || 'user')}</div>
          <div class="comment-time">${new Date(c.createdAt).toLocaleString()}</div>
          <div class="comment-body">${esc(c.body)}</div>
        </div>`;
    }

    div.innerHTML = metaHtml + '<div class="thread-replies">' + commentsHtml + '</div>';

    const replySection = document.createElement('div');
    replySection.style.padding = '0 12px 8px';
    replySection.style.display = 'flex';
    replySection.style.gap = '6px';

    const replyInput = document.createElement('input');
    replyInput.placeholder = thread.resolved ? 'Unresolve to reply...' : 'Reply...';
    replyInput.disabled = thread.resolved;
    replySection.style.padding = '0 12px 8px';
    replySection.appendChild(replyInput);

    const replyBtn = document.createElement('button');
    replyBtn.textContent = 'Reply';
    replyBtn.disabled = thread.resolved;
    replyBtn.addEventListener('click', async () => {
      if (!replyInput.value.trim() || thread.resolved) return;
      try {
        await api('POST', '/comment-lines', { threadId: thread.id, body: replyInput.value.trim() });
        replyInput.value = '';
        await loadThreads();
      } catch (e) {
        alert(e.message);
      }
    });
    replySection.appendChild(replyBtn);
    div.appendChild(replySection);

    // Resolve button handler
    const resolveBtn = div.querySelector('.btn-resolve');
    resolveBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api('POST', `/comments/threads/${thread.id}/resolve`);
        await loadThreads();
        updateCommentMarkers();
      } catch (e) {
        alert('Resolve failed: ' + e.message);
      }
    });

    container.appendChild(div);
  }
}

$('#show-resolved').addEventListener('change', (e) => {
  showResolved = e.target.checked;
  renderThreads();
});

$('#btn-add-thread').addEventListener('click', async () => {
  const body = $('#thread-body').value.trim();
  if (!body || !currentDoc) return;

  // Get current cursor position in editor to anchor the comment
  const cursorPos = editor.selectionStart;
  const selectionEnd = editor.selectionEnd;
  const textBefore = editor.value.substring(0, cursorPos);
  const startLine = textBefore.split('\n').length;

  // If there's a selection in editor, get its text
  const selectedText = cursorPos !== selectionEnd
    ? editor.value.substring(cursorPos, selectionEnd).trim()
    : '';
  const endLine = cursorPos !== selectionEnd
    ? editor.value.substring(0, selectionEnd).split('\n').length
    : startLine;

  try {
    await api('POST', '/comments/threads', {
      documentId: currentDoc.id,
      body,
      anchor: { startLine, endLine, selectedText }
    });
    $('#thread-body').value = '';
    await loadThreads();
    updateCommentMarkers();
  } catch (e) {
    alert('Failed to create thread: ' + e.message);
  }
});

$('#thread-body').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#btn-add-thread').click();
  }
});

/* ===== Utilities ===== */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ===== Init: Check Session ===== */
initAuth();
