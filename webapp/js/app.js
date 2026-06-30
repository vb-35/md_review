const API = (() => {
  let path = window.location.pathname || '/';
  if (path.endsWith('/index.html')) {
    path = path.slice(0, -'/index.html'.length) || '/';
  }
  if (path === '/' || path === '') return '/api';
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  return `${normalized}/api`;
})();

let currentUser = null;
let currentDoc = null;
let docs = [];
let docShares = [];
let selectedDashboardDocId = null;
let versions = [];
let selectedBaseId = null;
let selectedHeadId = null;
let threads = [];
let editing = false;
let showResolved = false;
let authMode = null;
let passwordLoginEnabled = true;
let currentView = 'dashboard';
let previewTimer = null;
let mathPlaceholders = {};
let placeholderCounter = 0;

function getLineNumberAtOffset(text, offset) {
  let lineNumber = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') lineNumber += 1;
  }
  return lineNumber;
}

const $ = (sel) => document.querySelector(sel);

function headers() {
  return {
    'Content-Type': 'application/json',
    ...(currentUser ? { 'X-User-Id': currentUser.id } : {})
  };
}

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

function canEditCurrentDoc() {
  return !!currentDoc && ['owner', 'editor'].includes(currentDoc.accessRole);
}

function canCommentCurrentDoc() {
  return !!currentDoc;
}

function canResolveThreads() {
  return canEditCurrentDoc();
}

function canManageShares() {
  return !!currentDoc && currentDoc.isOwner;
}

function holdsCurrentLock() {
  return !!currentDoc && currentDoc.lockOwnerId === currentUser.id;
}

function formatDate(value) {
  if (!value) return 'Unknown';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function closePanels() {
  $('#review-panel').classList.add('hidden');
  $('#comments-panel').classList.add('hidden');
}

function showTopbar() {
  $('#topbar').classList.remove('hidden');
  $('#user-display').textContent = currentUser.username;
}

function showLoginScreen(message = '') {
  const hint = $('#login-hint');
  const form = $('#login-form');
  const error = $('#login-error');

  $('#topbar').classList.add('hidden');
  $('#dashboard-screen').classList.add('hidden');
  $('#editor-screen').classList.add('hidden');
  closePanels();
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

function showDashboard() {
  currentView = 'dashboard';
  $('#login-screen').classList.add('hidden');
  $('#editor-screen').classList.add('hidden');
  $('#dashboard-screen').classList.remove('hidden');
  closePanels();
  updateHeader();
}

function showEditor() {
  currentView = 'editor';
  $('#login-screen').classList.add('hidden');
  $('#dashboard-screen').classList.add('hidden');
  $('#editor-screen').classList.remove('hidden');
  updateHeader();
}

function updateHeader() {
  const title = $('#doc-title');
  const roleBadge = $('#doc-role-badge');
  const lockBadge = $('#lock-badge');

  if (!currentDoc) {
    title.textContent = currentView === 'dashboard' ? 'Documents Dashboard' : '';
    roleBadge.classList.add('hidden');
    lockBadge.classList.add('hidden');
    $('#btn-save').disabled = true;
    $('#btn-lock').disabled = true;
    $('#btn-review').disabled = true;
    $('#btn-threads').disabled = true;
    $('#btn-menu').textContent = 'Documents';
    return;
  }

  title.textContent = currentDoc.title;
  roleBadge.textContent = capitalize(currentDoc.accessRole);
  roleBadge.classList.remove('hidden');

  if (currentDoc.lockOwnerId) {
    lockBadge.textContent = holdsCurrentLock()
      ? 'Locked by you'
      : `Locked by ${currentDoc.lockOwnerUsername || 'another user'}`;
    lockBadge.classList.remove('hidden');
  } else {
    lockBadge.classList.add('hidden');
  }

  updateEditorPermissions();
  $('#btn-review').disabled = false;
  $('#btn-threads').disabled = false;
  $('#btn-menu').textContent = currentView === 'editor' ? 'Back to Documents' : 'Documents';
}

function updateEditorPermissions() {
  const canEdit = canEditCurrentDoc();
  const saveEnabled = canEdit && holdsCurrentLock() && editing;
  const lockDisabled = !currentDoc || !canEdit || (!!currentDoc.lockOwnerId && !holdsCurrentLock());

  $('#btn-save').disabled = !saveEnabled;
  $('#btn-lock').disabled = lockDisabled;

  if (!currentDoc || !canEdit) {
    $('#btn-lock').textContent = 'Lock';
  } else if (holdsCurrentLock()) {
    $('#btn-lock').textContent = 'Unlock';
  } else if (currentDoc.lockOwnerId) {
    $('#btn-lock').textContent = 'Locked';
  } else {
    $('#btn-lock').textContent = 'Lock';
  }

  $('#editor').readOnly = !(canEdit && holdsCurrentLock());
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
    currentUser = loginToken ? await loginWithToken(loginToken) : await bootstrapAuth();
    showTopbar();
    showDashboard();
    await loadDocs();
  } catch (e) {
    currentUser = null;
    showLoginScreen(e.message);
  }
}

async function login(username, password) {
  try {
    const response = await api('POST', '/auth/login', { username, password });
    currentUser = response.user || response;
    showTopbar();
    showDashboard();
    await loadDocs();
  } catch (e) {
    const err = $('#login-error');
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
}

async function logout() {
  try {
    await api('POST', '/auth/logout');
  } catch {}
  currentUser = null;
  currentDoc = null;
  docs = [];
  docShares = [];
  selectedDashboardDocId = null;
  authMode = null;
  passwordLoginEnabled = true;
  await initAuth();
}

async function loadDocs() {
  docs = await api('GET', '/documents');
  renderDocLists();

  if (!docs.length) {
    selectedDashboardDocId = null;
    currentDoc = null;
    docShares = [];
    renderDocDetail();
    updateHeader();
    return;
  }

  const stillExists = docs.some((doc) => doc.id === selectedDashboardDocId);
  if (!stillExists) {
    selectedDashboardDocId = docs[0].id;
  }
  await selectDashboardDoc(selectedDashboardDocId, false);
}

function renderDocLists() {
  renderDocSection('#owned-docs', docs.filter((doc) => doc.isOwner));
  renderDocSection('#shared-docs', docs.filter((doc) => !doc.isOwner));
}

function renderDocSection(selector, items) {
  const container = $(selector);
  if (!items.length) {
    container.innerHTML = '<div class="empty-state">No documents in this section.</div>';
    return;
  }

  container.innerHTML = items.map((doc) => `
    <article class="document-card ${doc.id === selectedDashboardDocId ? 'active' : ''}" data-doc-id="${doc.id}">
      <div class="document-card-header">
        <div class="document-card-title">${esc(doc.title)}</div>
        <div class="document-card-role">${capitalize(doc.accessRole)}</div>
      </div>
      <div class="document-card-meta">
        <div>Owner: ${esc(doc.ownerUsername || 'Unknown')}</div>
        <div>Updated: ${esc(formatDate(doc.updatedAt))}</div>
        <div>Updated by: ${esc(doc.updatedByUsername || 'Unknown')}</div>
        <div>${doc.lockOwnerId ? `Lock: ${esc(doc.lockOwnerUsername || 'Locked')}` : 'Lock: Unlocked'}</div>
      </div>
    </article>
  `).join('');

  container.querySelectorAll('.document-card').forEach((card) => {
    card.addEventListener('click', () => {
      selectDashboardDoc(card.dataset.docId);
    });
  });
}

async function selectDashboardDoc(docId, rerenderList = true) {
  if (!docId) return;
  selectedDashboardDocId = docId;
  if (rerenderList) renderDocLists();
  currentDoc = await api('GET', `/documents/${docId}`);
  docShares = [];
  if (canManageShares()) {
    docShares = await api('GET', `/documents/${docId}/shares`);
  }
  renderDocDetail();
  updateHeader();
}

function renderDocDetail() {
  const empty = $('#doc-detail-empty');
  const detail = $('#doc-detail');
  const shareCard = $('#share-card');
  const deleteBtn = $('#btn-delete-doc');
  const shareError = $('#share-error');
  shareError.classList.add('hidden');
  shareError.textContent = '';

  if (!currentDoc) {
    empty.classList.remove('hidden');
    detail.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  detail.classList.remove('hidden');
  $('#detail-title').textContent = currentDoc.title;
  $('#detail-subtitle').textContent = `${capitalize(currentDoc.accessRole)} access${currentDoc.isOwner ? ' • Owner' : ` • Shared by ${currentDoc.sharedByUsername || 'unknown'}`}`;
  $('#doc-access-summary').innerHTML = currentDoc.isOwner
    ? 'You own this document. You can edit, lock, delete, and manage sharing.'
    : currentDoc.accessRole === 'editor'
      ? `You can edit this document after taking the lock. Shared by ${esc(currentDoc.sharedByUsername || 'unknown')}.`
      : `You can view and comment on this document, but editing and sharing are disabled. Shared by ${esc(currentDoc.sharedByUsername || 'unknown')}.`;

  $('#doc-metadata').innerHTML = `
    <dt>Owner</dt><dd>${esc(currentDoc.ownerUsername || 'Unknown')}</dd>
    <dt>Role</dt><dd>${esc(capitalize(currentDoc.accessRole))}</dd>
    <dt>Updated</dt><dd>${esc(formatDate(currentDoc.updatedAt))}</dd>
    <dt>Updated By</dt><dd>${esc(currentDoc.updatedByUsername || 'Unknown')}</dd>
    <dt>Lock</dt><dd>${currentDoc.lockOwnerId ? esc(currentDoc.lockOwnerUsername || 'Locked') : 'Unlocked'}</dd>
  `;

  deleteBtn.classList.toggle('hidden', !currentDoc.isOwner);
  shareCard.classList.toggle('hidden', !canManageShares());
  if (canManageShares()) {
    renderShares();
  }
}

function renderShares() {
  const list = $('#share-list');
  if (!docShares.length) {
    list.innerHTML = '<div class="empty-state">This document has not been shared yet.</div>';
    return;
  }

  list.innerHTML = docShares.map((share) => `
    <div class="share-row">
      <div class="share-row-meta">
        <div class="share-row-username">${esc(share.username)}</div>
        <div class="share-row-subtitle">Role: ${esc(capitalize(share.role))} • Shared by ${esc(share.sharedByUsername)} • ${esc(formatDate(share.createdAt))}</div>
      </div>
      <div class="share-row-actions">
        <select data-user-id="${share.userId}" class="share-role-select">
          <option value="viewer" ${share.role === 'viewer' ? 'selected' : ''}>Viewer</option>
          <option value="editor" ${share.role === 'editor' ? 'selected' : ''}>Editor</option>
        </select>
        <button data-user-id="${share.userId}" class="share-remove-btn danger">Remove</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.share-role-select').forEach((select) => {
    select.addEventListener('change', async () => {
      const share = docShares.find((item) => item.userId === select.dataset.userId);
      if (!share) return;
      try {
        await api('POST', `/documents/${currentDoc.id}/shares`, {
          username: share.username,
          role: select.value
        });
        docShares = await api('GET', `/documents/${currentDoc.id}/shares`);
        renderShares();
        await loadDocs();
      } catch (e) {
        alert(`Failed to update share: ${e.message}`);
      }
    });
  });

  list.querySelectorAll('.share-remove-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api('DELETE', `/documents/${currentDoc.id}/shares/${button.dataset.userId}`);
        docShares = await api('GET', `/documents/${currentDoc.id}/shares`);
        renderShares();
        await loadDocs();
      } catch (e) {
        alert(`Failed to remove share: ${e.message}`);
      }
    });
  });
}

async function openDoc(docId) {
  currentDoc = await api('GET', `/documents/${docId}`);
  editing = false;
  $('#editor').value = currentDoc.markdown || '';
  renderPreview();
  await loadThreads();
  showEditor();
  updateHeader();
}

function maybeConfirmDiscard() {
  if (editing && canEditCurrentDoc() && holdsCurrentLock()) {
    return window.confirm('Discard unsaved changes and return to the documents dashboard?');
  }
  return true;
}

async function saveDoc() {
  if (!currentDoc || !holdsCurrentLock()) return;
  try {
    currentDoc = await api('PUT', `/documents/${currentDoc.id}`, {
      markdown: $('#editor').value
    });
    editing = false;
    renderPreview();
    await loadThreads();
    await loadDocs();
    updateHeader();
  } catch (e) {
    alert(`Save failed: ${e.message}`);
  }
}

async function tryLockDoc() {
  if (!currentDoc) return;
  try {
    currentDoc = await api('POST', `/documents/${currentDoc.id}/lock`);
    updateHeader();
  } catch (e) {
    alert(e.message.includes('locked by another user')
      ? 'This document is locked by another user.'
      : e.message);
  }
}

async function unlockDoc() {
  if (!currentDoc) return;
  try {
    await api('DELETE', `/documents/${currentDoc.id}/lock`);
    currentDoc.lockOwnerId = null;
    currentDoc.lockOwnerUsername = null;
    currentDoc.lockedAt = null;
    updateHeader();
  } catch (e) {
    alert(e.message);
  }
}

function preprocessMath(md) {
  const source = md;
  mathPlaceholders = {};
  placeholderCounter = 0;

  md = md.replace(/\$\$([\s\S]+?)\$\$/g, (match, math, offset) => {
    const key = `{MATHB:${placeholderCounter++}}`;
    mathPlaceholders[key] = {
      type: 'block',
      math: math.trim(),
      line: getLineNumberAtOffset(source, offset)
    };
    return `\n\n${key}\n\n`;
  });

  md = md.replace(/\$([^\$\n]+?)\$/g, (match, math, offset) => {
    const key = `{MATHI:${placeholderCounter++}}`;
    mathPlaceholders[key] = {
      type: 'inline',
      math,
      line: getLineNumberAtOffset(source, offset)
    };
    return ` ${key} `;
  });

  return md;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderDiffSegments(line) {
  if (!Array.isArray(line.segments) || !line.segments.length) {
    return esc(line.line);
  }

  return line.segments.map((segment) => {
    const text = esc(segment.text || '');
    return segment.changed
      ? `<span class="diff-token-changed">${text}</span>`
      : text;
  }).join('');
}

function postprocessMath(html) {
  for (const [key, { type, math, line }] of Object.entries(mathPlaceholders)) {
    let rendered;
    try {
      rendered = katex.renderToString(math, {
        throwOnError: false,
        displayMode: type === 'block'
      });
    } catch {
      rendered = `<code>${escapeHtml(math)}</code>`;
    }
    const lineAttr = line ? ` data-line="${line}"` : '';
    const wrapper = type === 'block'
      ? `<div class="math-block"${lineAttr}>${rendered}</div>`
      : `<span class="math-inline"${lineAttr}>${rendered}</span>`;
    html = html.split(key).join(wrapper);
  }
  return html;
}

function renderHighlight(container) {
  container.querySelectorAll('pre code').forEach((block) => {
    try {
      hljs.highlightElement(block);
    } catch {}
  });
}

function annotateLines(container, source) {
  const lines = source.split('\n');
  const blockEls = container.querySelectorAll('h1, h2, h3, h4, h5, h6, p, pre, blockquote, li, td, tr, table, ul, ol, div.math-block, hr');
  const processed = new Set();

  for (const el of blockEls) {
    if (processed.has(el)) continue;
    if (el.hasAttribute('data-line')) {
      processed.add(el);
      continue;
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let tn;
    let lineNumber = null;
    while ((tn = walker.nextNode())) {
      const content = tn.textContent.trim();
      if (!content) continue;
      const searchText = content.substring(0, 50);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(searchText)) {
          lineNumber = i + 1;
          break;
        }
      }
      break;
    }

    if (lineNumber) {
      el.setAttribute('data-line', lineNumber);
    }
    processed.add(el);
  }
}

function getLineStartOffset(source, lineNumber) {
  if (lineNumber <= 1) return 0;

  let offset = 0;
  let currentLine = 1;
  while (currentLine < lineNumber && offset < source.length) {
    const nextBreak = source.indexOf('\n', offset);
    if (nextBreak === -1) return source.length;
    offset = nextBreak + 1;
    currentLine += 1;
  }
  return offset;
}

function getLineTextAt(source, lineNumber) {
  const start = getLineStartOffset(source, lineNumber);
  const end = source.indexOf('\n', start);
  return source.slice(start, end === -1 ? source.length : end);
}

function getPreviewCaretAtPoint(event) {
  if (document.caretPositionFromPoint) {
    const caret = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (caret) {
      return { node: caret.offsetNode, offset: caret.offset };
    }
  }

  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (range) {
      return { node: range.startContainer, offset: range.startOffset };
    }
  }

  return null;
}

function getRenderedTextOffset(container, node, offset) {
  if (!container || !node) return null;

  try {
    const range = document.createRange();
    range.setStart(container, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function getTokenAtTextPosition(text, offset) {
  if (!text) return null;

  const clampedOffset = Math.max(0, Math.min(offset, text.length));
  const isTokenChar = (char) => /[A-Za-z0-9_]/.test(char);
  let index = clampedOffset;

  if (index >= text.length || !isTokenChar(text[index])) {
    if (index > 0 && isTokenChar(text[index - 1])) {
      index -= 1;
    } else {
      return null;
    }
  }

  let start = index;
  let end = index + 1;
  while (start > 0 && isTokenChar(text[start - 1])) start -= 1;
  while (end < text.length && isTokenChar(text[end])) end += 1;

  return {
    token: text.slice(start, end),
    offsetInText: start,
    offsetInToken: index - start
  };
}

function getBestTokenMatchOffset(lineText, token, preferredRatio, offsetInToken = 0) {
  if (!token) return null;

  const matches = [];
  let index = -1;
  while ((index = lineText.indexOf(token, index + 1)) !== -1) {
    const before = index === 0 ? '' : lineText[index - 1];
    const after = index + token.length >= lineText.length ? '' : lineText[index + token.length];
    if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
    matches.push(index);
  }

  if (!matches.length) return null;
  if (matches.length === 1) return matches[0] + Math.min(offsetInToken, token.length);

  const targetIndex = Math.max(0, Math.min(lineText.length, Math.round(lineText.length * preferredRatio)));
  let best = matches[0];
  let bestDistance = Math.abs(matches[0] - targetIndex);

  for (const matchIndex of matches.slice(1)) {
    const distance = Math.abs(matchIndex - targetIndex);
    if (distance < bestDistance) {
      best = matchIndex;
      bestDistance = distance;
    }
  }

  return best + Math.min(offsetInToken, token.length);
}

function getMathExpressionOffset(source, lineNumber, isBlockMath) {
  const lineStart = getLineStartOffset(source, lineNumber);
  const lineText = getLineTextAt(source, lineNumber);

  if (isBlockMath) {
    const blockIndex = lineText.indexOf('$$');
    if (blockIndex !== -1) return lineStart + blockIndex;
    return lineStart;
  }

  const inlineIndex = lineText.indexOf('$');
  if (inlineIndex !== -1) return lineStart + inlineIndex;
  return lineStart;
}

function getNearestInlineMathOffset(lineText, preferredRatio) {
  const matches = [];
  const regex = /\$([^\$\n]+?)\$/g;
  let match;

  while ((match = regex.exec(lineText)) !== null) {
    matches.push(match.index);
  }

  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];

  const targetIndex = Math.max(0, Math.min(lineText.length, Math.round(lineText.length * preferredRatio)));
  let best = matches[0];
  let bestDistance = Math.abs(matches[0] - targetIndex);

  for (const matchIndex of matches.slice(1)) {
    const distance = Math.abs(matchIndex - targetIndex);
    if (distance < bestDistance) {
      best = matchIndex;
      bestDistance = distance;
    }
  }

  return best;
}

function revealEditorOffset(offset) {
  const editor = $('#editor');
  const lineHeight = parseFloat(window.getComputedStyle(editor).lineHeight) || 22;
  const lineIndex = editor.value.slice(0, offset).split('\n').length - 1;
  const top = lineIndex * lineHeight;
  const bottom = top + lineHeight;

  if (top < editor.scrollTop) {
    editor.scrollTop = top;
  } else if (bottom > editor.scrollTop + editor.clientHeight) {
    editor.scrollTop = bottom - editor.clientHeight;
  }
}

function moveEditorCursorToPreviewClick(event) {
  if (event.target.closest('.comment-indicator, button, a')) return;

  const preview = $('#preview');
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && preview.contains(selection.anchorNode)) return;

  const lineEl = event.target.closest('[data-line]');
  if (!lineEl) return;

  const lineNumber = parseInt(lineEl.getAttribute('data-line'), 10);
  if (!lineNumber) return;

  const source = $('#editor').value || '';
  const lineStart = getLineStartOffset(source, lineNumber);
  const mathBlock = event.target.closest('.math-block');
  const mathInline = event.target.closest('.math-inline');
  const renderedText = lineEl.textContent || '';
  let targetOffset = lineStart;

  if (mathBlock) {
    targetOffset = getMathExpressionOffset(source, lineNumber, true);
  } else if (mathInline) {
    const caret = getPreviewCaretAtPoint(event);
    let preferredRatio = 0;

    if (caret && caret.node && lineEl.contains(caret.node)) {
      const offsetInRenderedText = getRenderedTextOffset(lineEl, caret.node, caret.offset);
      if (offsetInRenderedText !== null && renderedText.length) {
        preferredRatio = Math.max(0, Math.min(1, offsetInRenderedText / renderedText.length));
      }
    }

    const lineText = getLineTextAt(source, lineNumber);
    const inlineMathOffset = getNearestInlineMathOffset(lineText, preferredRatio);
    targetOffset = inlineMathOffset !== null
      ? lineStart + inlineMathOffset
      : getMathExpressionOffset(source, lineNumber, false);
  } else {
    const caret = getPreviewCaretAtPoint(event);
    const caretNode = caret && caret.node && lineEl.contains(caret.node) ? caret.node : null;
    const textNode = caretNode && caretNode.nodeType === Node.TEXT_NODE ? caretNode : null;

    if (textNode) {
      const tokenInfo = getTokenAtTextPosition(textNode.textContent || '', caret.offset);
      if (tokenInfo && tokenInfo.token) {
        const lineText = getLineTextAt(source, lineNumber);
        const offsetInRenderedText = getRenderedTextOffset(lineEl, textNode, caret.offset);
        const preferredRatio = renderedText.length && offsetInRenderedText !== null
          ? Math.max(0, Math.min(1, offsetInRenderedText / renderedText.length))
          : 0;
        const matchOffset = getBestTokenMatchOffset(
          lineText,
          tokenInfo.token,
          preferredRatio,
          tokenInfo.offsetInToken
        );
        if (matchOffset !== null) {
          targetOffset = lineStart + matchOffset;
        }
      }
    }
  }

  const editor = $('#editor');
  editor.focus();
  editor.setSelectionRange(targetOffset, targetOffset);
  revealEditorOffset(targetOffset);
}

function updateCommentMarkers() {
  const preview = $('#preview');
  preview.querySelectorAll('.comment-indicator').forEach((marker) => marker.remove());

  for (const thread of threads) {
    if (!thread.anchor || thread.resolved) continue;
    const targets = preview.querySelectorAll(`[data-line="${thread.anchor.startLine}"]`);
    targets.forEach((el) => {
      const indicator = document.createElement('span');
      indicator.className = 'comment-indicator';
      indicator.title = `${thread.comments.length} comment${thread.comments.length !== 1 ? 's' : ''}`;
      indicator.textContent = '●';
      indicator.addEventListener('click', (e) => {
        e.stopPropagation();
        openThreadInPanel(thread.id);
      });
      el.style.position = 'relative';
      el.prepend(indicator);
    });
  }
}

function renderPreview() {
  if (!currentDoc) return;
  let md = $('#editor').value || '';
  md = preprocessMath(md);
  const html = marked.parse(md);
  const finalHtml = postprocessMath(html);
  const preview = $('#preview');
  preview.innerHTML = finalHtml;
  annotateLines(preview, $('#editor').value);
  renderHighlight(preview);
  updateCommentMarkers();
}

function findLineFromSelection(range) {
  const node = range.startContainer;
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== $('#preview')) {
    if (el.hasAttribute && el.hasAttribute('data-line')) {
      return parseInt(el.getAttribute('data-line'), 10);
    }
    el = el.parentElement;
  }
  return null;
}

function showCommentPrompt(range, line) {
  const existing = document.querySelector('.selection-comment-prompt');
  if (existing) existing.remove();

  const rect = range.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.className = 'selection-comment-prompt';
  popup.innerHTML = '<button>Add comment</button>';
  popup.style.cssText = `
    position: fixed;
    left: ${rect.left}px;
    top: ${rect.top - 36}px;
    z-index: 200;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.35);
    padding: 4px 8px;
  `;

  popup.querySelector('button').addEventListener('click', async (e) => {
    e.stopPropagation();
    popup.remove();
    const body = window.prompt('Enter your comment:');
    if (!body || !body.trim()) return;

    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : '';

    try {
      await api('POST', '/comments/threads', {
        documentId: currentDoc.id,
        body: body.trim(),
        anchor: { startLine: line, endLine: line, selectedText }
      });
      await loadThreads();
      updateCommentMarkers();
    } catch (err) {
      alert(`Failed to create thread: ${err.message}`);
    }
  });

  document.body.appendChild(popup);
  const dismissHandler = (e) => {
    if (!popup.isConnected) return;
    if (!popup.contains(e.target)) {
      popup.remove();
      document.removeEventListener('mousedown', dismissHandler);
    }
  };
  document.addEventListener('mousedown', dismissHandler);
}

function initSelectionListener() {
  const preview = $('#preview');
  let selectionTimeout;
  preview.addEventListener('mouseup', () => {
    clearTimeout(selectionTimeout);
    selectionTimeout = setTimeout(() => {
      if (!canCommentCurrentDoc()) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!preview.contains(range.commonAncestorContainer)) return;
      const text = selection.toString().trim();
      if (!text || text.length < 2) return;
      const line = findLineFromSelection(range);
      if (!line) return;
      showCommentPrompt(range, line);
    }, 200);
  });
}

function initPreviewClickNavigation() {
  $('#preview').addEventListener('click', (event) => {
    moveEditorCursorToPreviewClick(event);
  });
}

function highlightThreadInPreview(threadId) {
  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return;

  document.querySelectorAll('.thread-text-highlight').forEach((el) => {
    el.classList.remove('thread-text-highlight');
  });

  const preview = $('#preview');
  if (thread.anchor && thread.anchor.selectedText) {
    const textToFind = thread.anchor.selectedText.trim();
    if (textToFind.length > 2) {
      const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, null);
      let textNode;
      while ((textNode = walker.nextNode())) {
        if (textNode.textContent.trim() !== textToFind) continue;
        let target = textNode.parentElement;
        while (target && target !== preview) {
          if (target.hasAttribute && target.hasAttribute('data-line')) {
            target.classList.add('thread-text-highlight');
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => target.classList.remove('thread-text-highlight'), 3000);
            return;
          }
          target = target.parentElement;
        }
      }
    }
  }

  if (thread.anchor && thread.anchor.startLine) {
    const target = preview.querySelector(`[data-line="${thread.anchor.startLine}"]`);
    if (target) {
      target.classList.add('thread-text-highlight');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => target.classList.remove('thread-text-highlight'), 3000);
    }
  }
}

function openThreadInPanel(threadId) {
  $('#comments-panel').classList.remove('hidden');
  loadThreads().then(() => {
    const threadEl = document.querySelector(`.thread[data-thread-id="${threadId}"]`);
    if (threadEl) {
      threadEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      threadEl.style.outline = '2px solid var(--accent)';
      setTimeout(() => {
        threadEl.style.outline = '';
      }, 2000);
    }
    highlightThreadInPreview(threadId);
  });
}

async function loadVersions() {
  if (!currentDoc) return;
  versions = await api('GET', `/documents/${currentDoc.id}/versions`);
  const baseSel = $('#version-select-base');
  const headSel = $('#version-select-head');
  baseSel.innerHTML = '<option value="">Base version...</option>';
  headSel.innerHTML = '<option value="">Head version...</option>';
  versions.forEach((v) => {
    const label = `v${v.version} - ${v.message} (${new Date(v.created_at).toLocaleString()})`;
    baseSel.innerHTML += `<option value="${v.id}">${esc(label)}</option>`;
    headSel.innerHTML += `<option value="${v.id}">${esc(label)}</option>`;
  });

  if (versions.length >= 2) {
    baseSel.value = versions[0].id;
    headSel.value = versions[1].id;
  } else if (versions.length === 1) {
    baseSel.value = versions[0].id;
  }
}

function renderDiff(lines) {
  let html = '';
  for (const line of lines) {
    const cls = line.type === 'added' ? 'added' : line.type === 'removed' ? 'removed' : 'context';
    const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
    html += `<div class="diff-line ${cls}" data-prefix="${prefix}">${renderDiffSegments(line)}</div>`;
  }
  $('#diff-view').innerHTML = html || '<p style="padding:20px;color:var(--fg-dim);text-align:center;">No differences</p>';
}

async function loadThreads() {
  if (!currentDoc) return;
  threads = await api('GET', `/documents/${currentDoc.id}/threads`);
  renderThreads();
}

function renderThreads() {
  const container = $('#thread-list');
  const canComment = canCommentCurrentDoc();
  const canResolve = canResolveThreads();
  const visibleThreads = threads.filter((t) => showResolved || !t.resolved);
  $('#thread-body').disabled = !canComment;
  $('#btn-add-thread').disabled = !canComment;
  $('#thread-body').placeholder = canComment ? 'New comment...' : 'Document access required to comment';

  if (!threads.length) {
    container.innerHTML = '<p style="color:var(--fg-dim);text-align:center;padding:20px;">No comments yet</p>';
    return;
  }

  if (!visibleThreads.length) {
    container.innerHTML = '<p style="color:var(--fg-dim);text-align:center;padding:20px;">All comments resolved</p>';
    return;
  }

  container.innerHTML = '';
  visibleThreads.forEach((thread) => {
    const div = document.createElement('div');
    div.className = `thread${thread.resolved ? ' thread-resolved' : ''}`;
    div.dataset.threadId = thread.id;
    div.innerHTML = `
      <div class="thread-meta">
        <span class="author">${esc(thread.createdByUsername || '?')}</span>
        <span class="time">${esc(formatDate(thread.createdAt))}</span>
        <button class="btn-resolve" ${!canResolve ? 'disabled' : ''}>${thread.resolved ? 'Unresolve' : 'Resolve'}</button>
      </div>
      ${thread.anchor ? `<div class="anchor-info">Lines ${thread.anchor.startLine}-${thread.anchor.endLine}</div>` : ''}
      ${thread.resolved ? `<div class="resolved-badge">Resolved${thread.resolvedAt ? ` on ${esc(new Date(thread.resolvedAt).toLocaleDateString())}` : ''}</div>` : ''}
      <div class="thread-replies">
        ${(thread.comments || []).map((c) => `
          <div class="comment">
            <div class="comment-author">${esc(c.username || 'user')}</div>
            <div class="comment-time">${esc(formatDate(c.createdAt))}</div>
            <div class="comment-body">${esc(c.body)}</div>
          </div>
        `).join('')}
      </div>
    `;

    const replySection = document.createElement('div');
    replySection.className = 'new-thread';
    const replyInput = document.createElement('input');
    replyInput.placeholder = canComment ? 'Reply...' : 'Document access required to reply';
    replyInput.disabled = !canComment || thread.resolved;
    const replyBtn = document.createElement('button');
    replyBtn.textContent = 'Reply';
    replyBtn.disabled = !canComment || thread.resolved;
    replyBtn.addEventListener('click', async () => {
      if (!replyInput.value.trim()) return;
      try {
        await api('POST', '/comment-lines', { threadId: thread.id, body: replyInput.value.trim() });
        await loadThreads();
      } catch (e) {
        alert(e.message);
      }
    });
    replySection.appendChild(replyInput);
    replySection.appendChild(replyBtn);
    div.appendChild(replySection);

    div.addEventListener('click', (e) => {
      if (e.target.closest('.btn-resolve') || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      openThreadInPanel(thread.id);
    });

    div.querySelector('.btn-resolve').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!canResolve) return;
      try {
        await api('POST', `/comments/threads/${thread.id}/resolve`);
        await loadThreads();
        updateCommentMarkers();
      } catch (err) {
        alert(`Resolve failed: ${err.message}`);
      }
    });

    container.appendChild(div);
  });
}

marked.setOptions({
  breaks: true,
  gfm: true,
  headerIds: false,
  mangle: false
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').classList.add('hidden');
  await login($('#login-username').value, $('#login-password').value);
});

$('#btn-logout').addEventListener('click', logout);

$('#btn-menu').addEventListener('click', async () => {
  if (currentView === 'editor') {
    if (!maybeConfirmDiscard()) return;
    showDashboard();
    await loadDocs();
  }
});

$('#btn-new-doc').addEventListener('click', async () => {
  const title = prompt('Document title:');
  if (!title) return;
  const doc = await api('POST', '/documents', { title, markdown: `# ${title}\n\n` });
  await loadDocs();
  await selectDashboardDoc(doc.id);
});

$('#btn-open-doc').addEventListener('click', async () => {
  if (!currentDoc) return;
  await openDoc(currentDoc.id);
});

$('#btn-delete-doc').addEventListener('click', async () => {
  if (!currentDoc || !currentDoc.isOwner) return;
  if (!window.confirm('Delete this document?')) return;
  await api('DELETE', `/documents/${currentDoc.id}`);
  currentDoc = null;
  selectedDashboardDocId = null;
  await loadDocs();
});

$('#share-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#share-username').value.trim();
  const role = $('#share-role').value;
  const error = $('#share-error');
  error.classList.add('hidden');
  error.textContent = '';

  if (!username || !currentDoc) return;
  try {
    await api('POST', `/documents/${currentDoc.id}/shares`, { username, role });
    $('#share-username').value = '';
    docShares = await api('GET', `/documents/${currentDoc.id}/shares`);
    renderShares();
    await loadDocs();
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
});

$('#editor').addEventListener('input', () => {
  editing = true;
  updateHeader();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 300);
});

$('#editor').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveDoc();
  }
  if (e.key === 'Tab' && !$('#editor').readOnly) {
    e.preventDefault();
    const start = $('#editor').selectionStart;
    const end = $('#editor').selectionEnd;
    const value = $('#editor').value;
    $('#editor').value = `${value.substring(0, start)}    ${value.substring(end)}`;
    $('#editor').selectionStart = $('#editor').selectionEnd = start + 4;
    editing = true;
    updateHeader();
  }
});

$('#btn-save').addEventListener('click', saveDoc);

$('#btn-lock').addEventListener('click', async () => {
  if (!currentDoc) return;
  if (holdsCurrentLock()) {
    await unlockDoc();
  } else {
    await tryLockDoc();
  }
  await loadDocs();
  updateHeader();
});

$('#btn-review').addEventListener('click', async () => {
  if (!currentDoc) return;
  $('#review-panel').classList.remove('hidden');
  await loadVersions();
});

$('#btn-close-review').addEventListener('click', () => $('#review-panel').classList.add('hidden'));

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
    $('#diff-meta').textContent = `v${result.versionA} -> v${result.versionB}`;
    $('#btn-revert').dataset.versionId = selectedHeadId;
    $('#btn-revert').disabled = !canEditCurrentDoc();
  } catch (e) {
    alert(`Diff failed: ${e.message}`);
  }
});

$('#btn-revert').addEventListener('click', async () => {
  const verId = $('#btn-revert').dataset.versionId;
  if (!verId || !canEditCurrentDoc()) return;
  if (!window.confirm('Revert document to this version? This will create a new version.')) return;
  try {
    await api('POST', `/versions/${verId}/revert`);
    currentDoc = await api('GET', `/documents/${currentDoc.id}`);
    $('#editor').value = currentDoc.markdown || '';
    editing = false;
    renderPreview();
    await loadThreads();
    await loadVersions();
    await loadDocs();
    updateHeader();
  } catch (e) {
    alert(`Revert failed: ${e.message}`);
  }
});

$('#btn-threads').addEventListener('click', async () => {
  if (!currentDoc) return;
  $('#comments-panel').classList.remove('hidden');
  await loadThreads();
});

$('#btn-close-comments').addEventListener('click', () => $('#comments-panel').classList.add('hidden'));

$('#show-resolved').addEventListener('change', (e) => {
  showResolved = e.target.checked;
  renderThreads();
});

$('#btn-add-thread').addEventListener('click', async () => {
  const body = $('#thread-body').value.trim();
  if (!body || !currentDoc || !canCommentCurrentDoc()) return;

  const cursorPos = $('#editor').selectionStart;
  const selectionEnd = $('#editor').selectionEnd;
  const textBefore = $('#editor').value.substring(0, cursorPos);
  const startLine = textBefore.split('\n').length;
  const selectedText = cursorPos !== selectionEnd
    ? $('#editor').value.substring(cursorPos, selectionEnd).trim()
    : '';
  const endLine = cursorPos !== selectionEnd
    ? $('#editor').value.substring(0, selectionEnd).split('\n').length
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
    alert(`Failed to create thread: ${e.message}`);
  }
});

$('#thread-body').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#btn-add-thread').click();
  }
});

initSelectionListener();
initPreviewClickNavigation();
initAuth();
