const API = (() => {
  let path = window.location.pathname || '/';
  if (path.endsWith('/index.html')) path = path.slice(0, -'/index.html'.length) || '/';
  if (path === '/' || path === '') return '/api';
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  return `${normalized}/api`;
})();

const SETTINGS_KEY_THEME = 'md-review.theme';
const SETTINGS_KEY_SYNC_VIEW = 'md-review.sync-view';
const SETTINGS_KEY_JUSTIFY_PREVIEW = 'md-review.justify-preview';
const HIGHLIGHT_THEME_DARK = 'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css';
const HIGHLIGHT_THEME_LIGHT = 'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css';

let currentUser = null;
let currentProject = null;
let currentFile = null;
let projects = [];
let projectShares = [];
let projectFiles = [];
let selectedProjectId = null;
let versions = [];
let threads = [];
let selectedBaseId = null;
let selectedHeadId = null;
let editing = false;
let showResolved = false;
let passwordLoginEnabled = true;
let currentView = 'dashboard';
let previewTimer = null;
let mathPlaceholders = {};
let placeholderCounter = 0;
let settings = loadSettings();
let syncingScroll = false;

const $ = (sel) => document.querySelector(sel);

function loadSettings() {
  const theme = localStorage.getItem(SETTINGS_KEY_THEME);
  return {
    theme: theme === 'light' ? 'light' : 'dark',
    syncView: localStorage.getItem(SETTINGS_KEY_SYNC_VIEW) === 'true',
    justifyPreview: localStorage.getItem(SETTINGS_KEY_JUSTIFY_PREVIEW) !== 'false'
  };
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY_THEME, settings.theme);
  localStorage.setItem(SETTINGS_KEY_SYNC_VIEW, String(settings.syncView));
  localStorage.setItem(SETTINGS_KEY_JUSTIFY_PREVIEW, String(settings.justifyPreview));
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  const highlightTheme = $('#highlight-theme');
  if (highlightTheme) {
    highlightTheme.href = theme === 'light' ? HIGHLIGHT_THEME_LIGHT : HIGHLIGHT_THEME_DARK;
  }
}

function applySettings() {
  applyTheme(settings.theme);
  const syncToggle = $('#toggle-sync-view');
  if (syncToggle) syncToggle.checked = settings.syncView;
  const justifyToggle = $('#toggle-justify-preview');
  if (justifyToggle) justifyToggle.checked = settings.justifyPreview;
  document.body.classList.toggle('preview-justify-disabled', !settings.justifyPreview);
  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    input.checked = input.value === settings.theme;
  });
}

function toggleSettingsPanel(forceOpen) {
  const panel = $('#settings-panel');
  const button = $('#btn-settings');
  if (!panel || !button) return;
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !shouldOpen);
  button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
}

function syncScroll(source, target) {
  if (!settings.syncView || syncingScroll) return;
  const sourceRange = source.scrollHeight - source.clientHeight;
  const targetRange = target.scrollHeight - target.clientHeight;
  const ratio = sourceRange > 0 ? source.scrollTop / sourceRange : 0;
  syncingScroll = true;
  target.scrollTop = targetRange > 0 ? ratio * targetRange : 0;
  requestAnimationFrame(() => {
    syncingScroll = false;
  });
}

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

async function uploadProjectAsset(projectId, file, dirPath = '') {
  const body = new FormData();
  body.append('file', file);
  if (dirPath) body.append('path', dirPath);
  const res = await fetch(`${API}/projects/${projectId}/assets`, {
    method: 'POST',
    headers: currentUser ? { 'X-User-Id': currentUser.id } : {},
    credentials: 'include',
    body
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await res.json()
    : { error: 'Expected JSON response from asset upload' };
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value || '';
  return div.innerHTML;
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

function getLineNumberAtOffset(text, offset) {
  let lineNumber = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') lineNumber += 1;
  }
  return lineNumber;
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function insertAtCursor(text) {
  const editor = $('#editor');
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const value = editor.value;
  editor.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
  editor.selectionStart = editor.selectionEnd = start + text.length;
  editor.focus();
  editing = true;
  updateEditorPermissions();
}

function canEditCurrentProject() {
  return !!currentProject && ['owner', 'editor'].includes(currentProject.accessRole);
}

function canCommentCurrentProject() {
  return !!currentProject && !!currentFile;
}

function canManageShares() {
  return !!currentProject && currentProject.isOwner;
}

function holdsCurrentLock() {
  return !!currentProject && !!currentUser && currentProject.lockOwnerId === currentUser.id;
}

function currentCommentContext() {
  if (!currentProject || !currentFile || !currentProject.currentCommitSha) return null;
  return {
    projectId: currentProject.id,
    filePath: currentFile.filePath,
    commitSha: currentProject.currentCommitSha
  };
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
  $('#topbar').classList.add('hidden');
  $('#dashboard-screen').classList.add('hidden');
  $('#editor-screen').classList.add('hidden');
  closePanels();
  $('#login-screen').classList.remove('hidden');
  const hint = $('#login-hint');
  const form = $('#login-form');
  const error = $('#login-error');

  if (passwordLoginEnabled) {
    form.classList.remove('hidden');
    hint.textContent = message || '';
    hint.classList.toggle('hidden', !message);
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
  if (!currentProject) {
    title.textContent = currentView === 'dashboard' ? 'Projects Dashboard' : '';
    roleBadge.classList.add('hidden');
    lockBadge.classList.add('hidden');
    $('#btn-save').disabled = true;
    $('#btn-lock').disabled = true;
    $('#btn-review').disabled = true;
    $('#btn-threads').disabled = true;
    $('#btn-menu').textContent = 'Projects';
    return;
  }

  title.textContent = currentFile ? `${currentProject.title} / ${currentFile.filePath}` : currentProject.title;
  roleBadge.textContent = capitalize(currentProject.accessRole);
  roleBadge.classList.remove('hidden');
  if (currentProject.lockOwnerId) {
    lockBadge.textContent = holdsCurrentLock()
      ? 'Locked by you'
      : `Locked by ${currentProject.lockOwnerUsername || 'another user'}`;
    lockBadge.classList.remove('hidden');
  } else {
    lockBadge.classList.add('hidden');
  }
  updateEditorPermissions();
  $('#btn-review').disabled = !currentFile;
  $('#btn-threads').disabled = !currentFile;
  $('#btn-menu').textContent = currentView === 'editor' ? 'Back to Projects' : 'Projects';
}

function updateEditorPermissions() {
  const canEdit = canEditCurrentProject();
  const lockDisabled = !currentProject || !canEdit || (!!currentProject.lockOwnerId && !holdsCurrentLock());
  const saveEnabled = !!currentFile && canEdit && holdsCurrentLock() && editing;
  $('#btn-save').disabled = !saveEnabled;
  $('#btn-lock').disabled = lockDisabled;
  $('#btn-upload-image').disabled = !currentFile || !canEdit || !holdsCurrentLock();
  $('#editor').readOnly = !currentFile || !canEdit || !holdsCurrentLock();
  if (!currentProject || !canEdit) {
    $('#btn-lock').textContent = 'Lock';
  } else if (holdsCurrentLock()) {
    $('#btn-lock').textContent = 'Unlock';
  } else if (currentProject.lockOwnerId) {
    $('#btn-lock').textContent = 'Locked';
  } else {
    $('#btn-lock').textContent = 'Lock';
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
    let textNode;
    let lineNumber = null;
    while ((textNode = walker.nextNode())) {
      const content = textNode.textContent.trim();
      if (!content) continue;
      const searchText = content.substring(0, 50);
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(searchText)) {
          lineNumber = i + 1;
          break;
        }
      }
      break;
    }
    if (lineNumber) el.setAttribute('data-line', lineNumber);
    processed.add(el);
  }
}

function getLineStartOffset(source, lineNumber) {
  if (lineNumber <= 1) return 0;
  let offset = 0;
  let currentLineNumber = 1;
  while (currentLineNumber < lineNumber && offset < source.length) {
    const nextBreak = source.indexOf('\n', offset);
    if (nextBreak === -1) return source.length;
    offset = nextBreak + 1;
    currentLineNumber += 1;
  }
  return offset;
}

function getLineEndOffset(source, lineNumber) {
  const nextLineStart = getLineStartOffset(source, lineNumber + 1);
  return nextLineStart > 0 ? nextLineStart - 1 : source.length;
}

function getLineTextAt(source, lineNumber) {
  const start = getLineStartOffset(source, lineNumber);
  const end = source.indexOf('\n', start);
  return source.slice(start, end === -1 ? source.length : end);
}

function getPreviewCaretAtPoint(event) {
  if (document.caretPositionFromPoint) {
    const caret = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (caret) return { node: caret.offsetNode, offset: caret.offset };
  }
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (range) return { node: range.startContainer, offset: range.startOffset };
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
  while ((match = regex.exec(lineText)) !== null) matches.push(match.index);
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
    targetOffset = inlineMathOffset !== null ? lineStart + inlineMathOffset : getMathExpressionOffset(source, lineNumber, false);
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
        const matchOffset = getBestTokenMatchOffset(lineText, tokenInfo.token, preferredRatio, tokenInfo.offsetInToken);
        if (matchOffset !== null) targetOffset = lineStart + matchOffset;
      }
    }
  }
  const editor = $('#editor');
  editor.focus();
  editor.setSelectionRange(targetOffset, targetOffset);
  revealEditorOffset(targetOffset);
}

function getSelectionLine(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== $('#preview')) {
    if (el.hasAttribute && el.hasAttribute('data-line')) return parseInt(el.getAttribute('data-line'), 10);
    el = el.parentElement;
  }
  return null;
}

function getSourceOffsetsFromPreviewSelection(startLine, endLine, selectedText) {
  const source = $('#editor').value || '';
  if (!selectedText || !startLine || !endLine) return null;
  const sliceStart = getLineStartOffset(source, startLine);
  const sliceEnd = getLineEndOffset(source, endLine);
  const sourceSlice = source.slice(sliceStart, sliceEnd);
  let matchIndex = sourceSlice.indexOf(selectedText);
  if (matchIndex === -1) {
    const escaped = selectedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const match = sourceSlice.match(new RegExp(escaped));
    matchIndex = match ? match.index : -1;
  }
  if (matchIndex === -1) return null;
  return {
    startOffset: sliceStart + matchIndex,
    endOffset: sliceStart + matchIndex + selectedText.length
  };
}

function getAnchorSelectedText(anchor) {
  if (anchor && anchor.selectedText && anchor.selectedText.trim()) return anchor.selectedText.trim();
  if (!anchor || typeof anchor.startOffset !== 'number' || typeof anchor.endOffset !== 'number') return '';
  return ($('#editor').value || '').slice(anchor.startOffset, anchor.endOffset).trim();
}

function getAnchorLabel(anchor) {
  if (!anchor) return '';
  const selectedText = getAnchorSelectedText(anchor);
  const lineLabel = `Lines ${anchor.startLine}-${anchor.endLine}`;
  if (!selectedText) return `<div class="anchor-info">${esc(lineLabel)}</div>`;
  const words = selectedText.split(/\s+/).filter(Boolean);
  const compact = words.length > 2 ? `${words[0]} ... ${words[words.length - 1]}` : selectedText;
  return `<div class="anchor-info"><div class="anchor-quote">${esc(compact)}</div><div class="anchor-lines">${esc(lineLabel)}</div></div>`;
}

function clearThreadHighlights() {
  document.querySelectorAll('.thread-text-highlight').forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize();
  });
}

function getPreviewSelectionTextNodes(preview, anchor) {
  const nodes = [];
  const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent) return NodeFilter.FILTER_REJECT;
      let el = node.parentElement;
      while (el && el !== preview) {
        if (el.hasAttribute && el.hasAttribute('data-line')) {
          const line = parseInt(el.getAttribute('data-line'), 10);
          return line >= anchor.startLine && line <= anchor.endLine
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
        el = el.parentElement;
      }
      return NodeFilter.FILTER_REJECT;
    }
  });
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
}

function scrollElementIntoContainer(container, target) {
  if (!container || !target) return;
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetTop = container.scrollTop + (targetRect.top - containerRect.top);
  const targetHeight = targetRect.height || target.offsetHeight || 0;
  const centeredTop = targetTop - ((container.clientHeight - targetHeight) / 2);
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const nextScrollTop = Math.max(0, Math.min(centeredTop, maxScrollTop));
  container.scrollTo({ top: nextScrollTop, behavior: 'smooth' });
}

function highlightPreviewText(anchor) {
  const preview = $('#preview');
  const textToFind = getAnchorSelectedText(anchor);
  if (!textToFind || !anchor || !anchor.startLine) return false;
  const textNodes = getPreviewSelectionTextNodes(preview, anchor);
  if (!textNodes.length) return false;
  const fullText = textNodes.map((node) => node.textContent).join('');
  const matchIndex = fullText.indexOf(textToFind);
  if (matchIndex === -1) return false;
  let remainingStart = matchIndex;
  let remainingEnd = matchIndex + textToFind.length;
  const spans = [];
  for (const node of textNodes) {
    const len = node.textContent.length;
    const startInNode = Math.max(0, remainingStart);
    const endInNode = Math.min(len, remainingEnd);
    if (startInNode < endInNode) {
      let target = node;
      if (startInNode > 0) target = target.splitText(startInNode);
      if (endInNode - startInNode < target.textContent.length) target.splitText(endInNode - startInNode);
      const span = document.createElement('span');
      span.className = 'thread-text-highlight';
      target.parentNode.insertBefore(span, target);
      span.appendChild(target);
      spans.push(span);
    }
    remainingStart -= len;
    remainingEnd -= len;
    if (remainingEnd <= 0) break;
  }
  if (!spans.length) return false;
  scrollElementIntoContainer(preview, spans[0]);
  setTimeout(clearThreadHighlights, 3000);
  return true;
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
      indicator.addEventListener('click', (event) => {
        event.stopPropagation();
        openThreadInPanel(thread.id);
      });
      el.style.position = 'relative';
      el.prepend(indicator);
    });
  }
}

function updatePreview() {
  if (!currentFile) {
    $('#preview').innerHTML = '';
    return;
  }
  let md = $('#editor').value || '';
  md = preprocessMath(md);
  const html = marked.parse(md);
  const finalHtml = postprocessMath(html);
  const preview = $('#preview');
  preview.innerHTML = finalHtml;
  annotateLines(preview, $('#editor').value || '');
  renderHighlight(preview);
  updateCommentMarkers();
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 120);
}

async function loadProjects() {
  projects = await api('GET', '/projects');
  renderProjectLists();
}

function renderProjectCards(container, items) {
  if (!items.length) {
    container.innerHTML = '<div class="empty-state">No projects in this section.</div>';
    return;
  }
  container.innerHTML = items.map((project) => `
    <article class="document-card ${project.id === selectedProjectId ? 'active' : ''}" data-project-id="${project.id}">
      <div class="document-card-header">
        <div class="document-card-title">${esc(project.title)}</div>
        <div class="document-card-role">${capitalize(project.accessRole)}</div>
      </div>
      <div class="document-card-meta">
        <div>Updated ${esc(formatDate(project.updatedAt))}</div>
        <div>${project.isOwner ? 'Owner' : `Shared by ${esc(project.sharedByUsername || 'unknown')}`}</div>
      </div>
    </article>
  `).join('');
  container.querySelectorAll('.document-card').forEach((card) => {
    card.addEventListener('click', () => openProjectDetail(card.dataset.projectId));
  });
}

function renderProjectLists() {
  renderProjectCards($('#owned-projects'), projects.filter((item) => item.isOwner));
  renderProjectCards($('#shared-projects'), projects.filter((item) => !item.isOwner));
}

async function openProjectDetail(projectId) {
  selectedProjectId = projectId;
  currentProject = await api('GET', `/projects/${projectId}`);
  projectFiles = (await api('GET', `/projects/${projectId}/files`)).items;
  projectShares = canManageShares() ? await api('GET', `/projects/${projectId}/shares`) : [];
  currentFile = null;
  editing = false;
  renderProjectLists();
  renderProjectDetail();
  updateHeader();
}

function renderProjectDetail() {
  $('#doc-detail-empty').classList.add('hidden');
  $('#doc-detail').classList.remove('hidden');
  $('#detail-title').textContent = currentProject.title;
  $('#detail-subtitle').textContent = currentProject.projectPath;
  $('#btn-delete-doc').classList.toggle('hidden', !currentProject.isOwner);
  $('#doc-metadata').innerHTML = `
    <dt>Role</dt><dd>${esc(capitalize(currentProject.accessRole))}</dd>
    <dt>Owner</dt><dd>${esc(currentProject.ownerUsername || 'Unknown')}</dd>
    <dt>Updated</dt><dd>${esc(formatDate(currentProject.updatedAt))}</dd>
    <dt>Commit</dt><dd>${esc(currentProject.currentCommitSha || 'No commits yet')}</dd>
  `;
  $('#doc-access-summary').textContent = currentProject.isOwner
    ? 'You own this project. You can lock, edit files, delete it, and manage sharing.'
    : currentProject.accessRole === 'editor'
      ? `You can edit this project after taking the lock. Shared by ${currentProject.sharedByUsername || 'unknown'}.`
      : `You can browse files and comment on Markdown files, but editing and sharing are disabled. Shared by ${currentProject.sharedByUsername || 'unknown'}.`;

  const fileList = $('#project-files');
  if (!projectFiles.length) {
    fileList.innerHTML = '<div class="empty-state">This project is empty.</div>';
  } else {
    fileList.innerHTML = projectFiles.map((item) => `
      <div class="share-row file-row">
        <div class="file-row-meta">
          <div class="file-row-path">${esc(item.path)}</div>
          <div class="file-row-subtitle">${item.kind === 'dir' ? 'Folder' : (item.isMarkdown ? 'Markdown file' : 'Asset')}</div>
        </div>
        <div class="file-row-actions">
          ${item.isMarkdown ? '<button data-action="open">Open</button>' : ''}
          <button data-action="rename">Rename</button>
          <button data-action="delete" class="danger">Delete</button>
        </div>
      </div>
    `).join('');
    fileList.querySelectorAll('.file-row').forEach((row, index) => {
      const item = projectFiles[index];
      row.querySelectorAll('button').forEach((button) => {
        button.addEventListener('click', async (event) => {
          event.stopPropagation();
          await handleFileAction(item, button.dataset.action);
        });
      });
    });
  }

  $('#share-card').classList.toggle('hidden', !canManageShares());
  renderShares();
}

function renderShares() {
  const list = $('#share-list');
  if (!canManageShares()) {
    list.innerHTML = '';
    return;
  }
  if (!projectShares.length) {
    list.innerHTML = '<div class="empty-state">This project has not been shared yet.</div>';
    return;
  }
  list.innerHTML = projectShares.map((share) => `
    <div class="share-row">
      <div class="share-row-meta">
        <div class="share-row-username">${esc(share.username)}</div>
        <div class="share-row-subtitle">${esc(capitalize(share.role))}</div>
      </div>
      <div class="share-row-actions">
        <button data-user-id="${share.userId}" class="danger">Remove</button>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', async () => {
      await api('DELETE', `/projects/${currentProject.id}/shares/${button.dataset.userId}`);
      projectShares = await api('GET', `/projects/${currentProject.id}/shares`);
      renderShares();
    });
  });
}

async function handleFileAction(item, action) {
  if (action === 'open') {
    await openMarkdownFile(item.path);
    return;
  }
  if (!canEditCurrentProject()) {
    alert('Edit access required.');
    return;
  }
  if (!holdsCurrentLock()) {
    alert('Take the project lock first.');
    return;
  }
  if (action === 'rename') {
    const nextPath = window.prompt('New path', item.path);
    if (!nextPath || nextPath === item.path) return;
    await api('POST', `/projects/${currentProject.id}/rename`, { oldPath: item.path, newPath: nextPath });
    await refreshProjectState(item.isMarkdown && currentFile && currentFile.filePath === item.path ? nextPath : null);
    return;
  }
  if (action === 'delete') {
    if (!window.confirm(`Delete ${item.path}?`)) return;
    await api('DELETE', `/projects/${currentProject.id}/files`, { path: item.path });
    const wasCurrent = currentFile && currentFile.filePath === item.path;
    await refreshProjectState(wasCurrent ? '' : null);
  }
}

async function refreshProjectState(nextCurrentFilePath = null) {
  if (!currentProject) return;
  currentProject = await api('GET', `/projects/${currentProject.id}`);
  projectFiles = (await api('GET', `/projects/${currentProject.id}/files`)).items;
  if (canManageShares()) {
    projectShares = await api('GET', `/projects/${currentProject.id}/shares`);
  }
  renderProjectDetail();
  updateHeader();
  if (nextCurrentFilePath === '') {
    currentFile = null;
    $('#editor').value = '';
    $('#editor-file-label').textContent = 'Source';
    $('#preview').innerHTML = '';
    editing = false;
    return;
  }
  if (typeof nextCurrentFilePath === 'string' && nextCurrentFilePath) {
    await openMarkdownFile(nextCurrentFilePath, false);
  }
}

async function openMarkdownFile(filePath, switchView = true) {
  currentProject = await api('GET', `/projects/${currentProject.id}`);
  currentFile = await api('GET', `/projects/${currentProject.id}/files/content?path=${encodeURIComponent(filePath)}`);
  $('#editor').value = currentFile.content || '';
  $('#editor-file-label').textContent = currentFile.filePath;
  editing = false;
  updatePreview();
  updateHeader();
  if (switchView) showEditor();
}

function renderDiff(diff) {
  $('#diff-view').innerHTML = diff.map((row) => {
    const prefix = row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' ';
    const text = (row.segments || [{ text: row.text || '', changed: false }]).map((segment) => (
      segment.changed ? `<span class="diff-token-changed">${esc(segment.text)}</span>` : esc(segment.text)
    )).join('');
    return `<div class="diff-line ${row.type}" data-prefix="${prefix}">${text}</div>`;
  }).join('');
}

async function loadVersions() {
  if (!currentFile) return;
  versions = await api('GET', `/projects/${currentProject.id}/files/versions?path=${encodeURIComponent(currentFile.filePath)}`);
  const baseSelect = $('#version-select-base');
  const headSelect = $('#version-select-head');
  const options = versions.map((version) => `
    <option value="${version.id}">v${version.version} · ${esc(version.author_name)} · ${esc(formatDate(version.created_at))}</option>
  `).join('');
  baseSelect.innerHTML = options;
  headSelect.innerHTML = options;
  if (versions[1]) {
    selectedBaseId = versions[1].id;
    selectedHeadId = versions[0].id;
  } else if (versions[0]) {
    selectedBaseId = versions[0].id;
    selectedHeadId = versions[0].id;
  }
  baseSelect.value = selectedBaseId || '';
  headSelect.value = selectedHeadId || '';
}

async function compareSelectedVersions() {
  if (!currentFile || !selectedBaseId || !selectedHeadId) return;
  const result = await api('POST', `/projects/${currentProject.id}/files/compare`, {
    path: currentFile.filePath,
    versionA: selectedBaseId,
    versionB: selectedHeadId
  });
  renderDiff(result.diff);
  $('#diff-meta').textContent = `v${result.versionA} -> v${result.versionB}`;
  $('#version-diff-actions').classList.remove('hidden');
}

async function revertSelectedVersion() {
  if (!selectedBaseId || !currentFile) return;
  if (!window.confirm('Revert file to the selected version? This creates a new version.')) return;
  const result = await api('POST', `/projects/${currentProject.id}/files/versions/${selectedBaseId}/revert`);
  await refreshProjectState(currentFile.filePath);
  $('#editor').value = result.content || '';
  editing = false;
  updatePreview();
  await loadVersions();
}

async function loadThreads() {
  const context = currentCommentContext();
  if (!context) {
    threads = [];
    renderThreads();
    return;
  }
  const query = new URLSearchParams({
    commitSha: context.commitSha,
    filePath: context.filePath
  });
  threads = await api('GET', `/projects/${currentProject.id}/threads?${query.toString()}`);
  renderThreads();
}

function renderThreads() {
  const list = $('#thread-list');
  const visibleThreads = threads.filter((thread) => showResolved || !thread.resolved);
  const canComment = canCommentCurrentProject();
  const canResolve = canEditCurrentProject();
  $('#thread-body').disabled = !canComment;
  $('#btn-add-thread').disabled = !canComment;
  $('#thread-body').placeholder = canComment ? 'New comment...' : 'File access required to comment';
  if (!visibleThreads.length) {
    list.innerHTML = '<div class="empty-state">No comments for this file.</div>';
    return;
  }
  list.innerHTML = '';

  visibleThreads.forEach((thread) => {
    const div = document.createElement('div');
    div.className = `thread${thread.resolved ? ' thread-resolved' : ''}`;
    div.dataset.threadId = thread.id;
    div.innerHTML = `
      <div class="thread-meta">
        <span class="author">${esc(thread.createdByUsername || '?')}</span>
        <span class="time">${esc(formatDate(thread.createdAt))}</span>
        <div class="thread-actions">
          <button class="btn-resolve" ${!canResolve ? 'disabled' : ''}>${thread.resolved ? 'Unresolve' : 'Resolve'}</button>
          ${thread.resolved ? `<button class="btn-delete-thread danger" ${!canResolve ? 'disabled' : ''}>Delete</button>` : ''}
        </div>
      </div>
      ${getAnchorLabel(thread.anchor)}
      ${thread.resolved ? `<div class="resolved-badge">Resolved${thread.resolvedAt ? ` on ${esc(new Date(thread.resolvedAt).toLocaleDateString())}` : ''}</div>` : ''}
      <div class="thread-replies">
        ${(thread.comments || []).map((comment) => `
          <div class="comment">
            <div class="comment-author">${esc(comment.username || 'user')}</div>
            <div class="comment-time">${esc(formatDate(comment.createdAt))}</div>
            <div class="comment-body">${esc(comment.body)}</div>
          </div>
        `).join('')}
      </div>
    `;

    const replySection = document.createElement('div');
    replySection.className = 'new-thread';
    const replyInput = document.createElement('input');
    replyInput.placeholder = canComment ? 'Reply...' : 'File access required to reply';
    replyInput.disabled = !canComment || thread.resolved;
    const replyBtn = document.createElement('button');
    replyBtn.textContent = 'Reply';
    replyBtn.disabled = !canComment || thread.resolved;
    replyBtn.addEventListener('click', async () => {
      if (!replyInput.value.trim()) return;
      try {
        const context = currentCommentContext();
        if (!context) throw new Error('Missing comment context for current file version');
        await api('POST', '/comment-lines', { ...context, threadId: thread.id, body: replyInput.value.trim() });
        await loadThreads();
      } catch (error) {
        alert(error.message);
      }
    });
    replySection.appendChild(replyInput);
    replySection.appendChild(replyBtn);
    div.appendChild(replySection);

    div.addEventListener('click', (event) => {
      if (event.target.closest('.btn-resolve') || event.target.closest('.btn-delete-thread') || event.target.tagName === 'INPUT' || event.target.tagName === 'BUTTON') return;
      openThreadInPanel(thread.id);
    });

    div.querySelector('.btn-resolve').addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!canResolve) return;
      try {
        const context = currentCommentContext();
        if (!context) throw new Error('Missing comment context for current file version');
        await api('POST', `/comments/threads/${thread.id}/resolve`, context);
        await loadThreads();
        updateCommentMarkers();
      } catch (error) {
        alert(`Resolve failed: ${error.message}`);
      }
    });

    const deleteBtn = div.querySelector('.btn-delete-thread');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!canResolve) return;
        if (!window.confirm('Delete this resolved thread permanently?')) return;
        try {
          const context = currentCommentContext();
          if (!context) throw new Error('Missing comment context for current file version');
          await api('DELETE', `/comments/threads/${thread.id}`, context);
          await loadThreads();
          updateCommentMarkers();
        } catch (error) {
          alert(`Delete failed: ${error.message}`);
        }
      });
    }

    list.appendChild(div);
  });
}

function showCommentPrompt(range, anchor) {
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
  popup.querySelector('button').addEventListener('click', async (event) => {
    event.stopPropagation();
    popup.remove();
    const body = window.prompt('Enter your comment:');
    if (!body || !body.trim()) return;
    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : '';
    const offsets = getSourceOffsetsFromPreviewSelection(anchor.startLine, anchor.endLine, selectedText);
    try {
      const context = currentCommentContext();
      if (!context) throw new Error('Missing comment context for current file version');
      await api('POST', '/comments/threads', {
        ...context,
        body: body.trim(),
        anchor: {
          startLine: anchor.startLine,
          endLine: anchor.endLine,
          startOffset: offsets ? offsets.startOffset : null,
          endOffset: offsets ? offsets.endOffset : null,
          selectedText
        }
      });
      await loadThreads();
      updateCommentMarkers();
    } catch (error) {
      alert(`Failed to create thread: ${error.message}`);
    }
  });
  document.body.appendChild(popup);
  const dismissHandler = (event) => {
    if (!popup.isConnected) return;
    if (!popup.contains(event.target)) {
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
      if (!canCommentCurrentProject()) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!preview.contains(range.commonAncestorContainer)) return;
      const text = selection.toString().trim();
      if (!text || text.length < 2) return;
      const startLine = getSelectionLine(range.startContainer);
      const endLine = getSelectionLine(range.endContainer);
      if (!startLine || !endLine) return;
      showCommentPrompt(range, { startLine, endLine });
    }, 200);
  });
}

function initPreviewClickNavigation() {
  $('#preview').addEventListener('click', (event) => {
    moveEditorCursorToPreviewClick(event);
  });
}

function openThreadInPanel(threadId) {
  $('#comments-panel').classList.remove('hidden');
  loadThreads().then(() => {
    const threadEl = document.querySelector(`.thread[data-thread-id="${threadId}"]`);
    const threadList = $('#thread-list');
    if (threadEl) {
      scrollElementIntoContainer(threadList, threadEl);
      threadEl.style.outline = '2px solid var(--accent)';
      setTimeout(() => {
        threadEl.style.outline = '';
      }, 2000);
    }
    clearThreadHighlights();
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return;
    if (thread.anchor && highlightPreviewText(thread.anchor)) return;
    if (thread.anchor && thread.anchor.startLine) {
      const target = $('#preview').querySelector(`[data-line="${thread.anchor.startLine}"]`);
      if (target) {
        target.classList.add('thread-text-highlight');
        scrollElementIntoContainer($('#preview'), target);
        setTimeout(() => target.classList.remove('thread-text-highlight'), 3000);
      }
    }
  });
}

async function createThread() {
  const context = currentCommentContext();
  const body = ($('#thread-body').value || '').trim();
  if (!context || !body) return;
  await api('POST', '/comments/threads', { ...context, body });
  $('#thread-body').value = '';
  await loadThreads();
}

function resetEditorState() {
  currentFile = null;
  $('#editor').value = '';
  $('#editor-file-label').textContent = 'Source';
  $('#preview').innerHTML = '';
  editing = false;
  versions = [];
  threads = [];
  closePanels();
}

async function bootstrap() {
  applySettings();
  try {
    const payload = await api('GET', '/auth/bootstrap');
    currentUser = payload.user;
    passwordLoginEnabled = payload.passwordLoginEnabled;
    showTopbar();
    showDashboard();
    await loadProjects();
  } catch (error) {
    passwordLoginEnabled = !/disabled/i.test(error.message);
    showLoginScreen();
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  try {
    const payload = await api('POST', '/auth/login', { username, password });
    currentUser = payload.user;
    showTopbar();
    showDashboard();
    await loadProjects();
  } catch (error) {
    $('#login-error').textContent = error.message;
    $('#login-error').classList.remove('hidden');
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  currentUser = null;
  currentProject = null;
  resetEditorState();
  showLoginScreen();
});

$('#btn-menu').addEventListener('click', async () => {
  if (currentView === 'editor' && editing && !window.confirm('Discard unsaved changes and return to the projects dashboard?')) {
    return;
  }
  resetEditorState();
  showDashboard();
  if (currentProject) {
    await refreshProjectState();
  }
});

$('#btn-new-project').addEventListener('click', async () => {
  const title = window.prompt('Project name');
  if (!title) return;
  const project = await api('POST', '/projects', { title });
  await loadProjects();
  await openProjectDetail(project.id);
});

$('#btn-delete-doc').addEventListener('click', async () => {
  if (!currentProject || !window.confirm('Delete this project?')) return;
  await api('DELETE', `/projects/${currentProject.id}`);
  currentProject = null;
  selectedProjectId = null;
  resetEditorState();
  await loadProjects();
  $('#doc-detail').classList.add('hidden');
  $('#doc-detail-empty').classList.remove('hidden');
  updateHeader();
});

$('#btn-new-file').addEventListener('click', async () => {
  if (!currentProject) return;
  if (!canEditCurrentProject()) return alert('Edit access required.');
  if (!holdsCurrentLock()) return alert('Take the project lock first.');
  const filePath = window.prompt('Markdown path', 'README.md');
  if (!filePath) return;
  await api('POST', `/projects/${currentProject.id}/files`, { path: filePath, content: '' });
  await refreshProjectState(filePath);
});

$('#btn-upload-asset').addEventListener('click', () => $('#upload-asset-input').click());

$('#upload-asset-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !currentProject) return;
  if (!canEditCurrentProject()) return alert('Edit access required.');
  if (!holdsCurrentLock()) return alert('Take the project lock first.');
  const dirPath = window.prompt('Upload into folder (blank for project root)', '') || '';
  await uploadProjectAsset(currentProject.id, file, dirPath.trim());
  await refreshProjectState();
});

$('#editor').addEventListener('input', () => {
  editing = true;
  updateEditorPermissions();
  schedulePreview();
});

$('#editor').addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();
    $('#btn-save').click();
  }
  if (event.key === 'Tab' && !$('#editor').readOnly) {
    event.preventDefault();
    const editor = $('#editor');
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = `${editor.value.substring(0, start)}    ${editor.value.substring(end)}`;
    editor.selectionStart = editor.selectionEnd = start + 4;
    editing = true;
    updateEditorPermissions();
    schedulePreview();
  }
});

$('#editor').addEventListener('scroll', () => syncScroll($('#editor'), $('#preview')));
$('#preview').addEventListener('scroll', () => syncScroll($('#preview'), $('#editor')));

$('#btn-save').addEventListener('click', async () => {
  if (!currentProject || !currentFile) return;
  currentFile = await api('PUT', `/projects/${currentProject.id}/files/content`, {
    path: currentFile.filePath,
    content: $('#editor').value
  });
  editing = false;
  await refreshProjectState(currentFile.filePath);
  updatePreview();
});

$('#btn-lock').addEventListener('click', async () => {
  if (!currentProject || !canEditCurrentProject()) return;
  if (holdsCurrentLock()) {
    await api('DELETE', `/projects/${currentProject.id}/lock`);
  } else {
    await api('POST', `/projects/${currentProject.id}/lock`);
  }
  await refreshProjectState(currentFile ? currentFile.filePath : null);
});

$('#btn-upload-image').addEventListener('click', () => $('#upload-image-input').click());

$('#upload-image-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !currentProject || !currentFile) return;
  const currentDir = currentFile.filePath.includes('/') ? currentFile.filePath.split('/').slice(0, -1).join('/') : '';
  const uploaded = await uploadProjectAsset(currentProject.id, file, currentDir);
  const markdown = `![${uploaded.filename}](${uploaded.url})`;
  insertAtCursor(markdown);
  updatePreview();
});

$('#btn-review').addEventListener('click', async () => {
  if (!currentFile) return;
  $('#review-panel').classList.remove('hidden');
  await loadVersions();
});

$('#btn-close-review').addEventListener('click', () => $('#review-panel').classList.add('hidden'));

$('#version-select-base').addEventListener('change', (event) => {
  selectedBaseId = event.target.value;
});

$('#version-select-head').addEventListener('change', (event) => {
  selectedHeadId = event.target.value;
});

$('#btn-compare').addEventListener('click', compareSelectedVersions);
$('#btn-revert').addEventListener('click', revertSelectedVersion);

$('#btn-threads').addEventListener('click', async () => {
  if (!currentFile) return;
  $('#comments-panel').classList.remove('hidden');
  await loadThreads();
});

$('#btn-close-comments').addEventListener('click', () => $('#comments-panel').classList.add('hidden'));
$('#btn-add-thread').addEventListener('click', createThread);
$('#show-resolved').addEventListener('change', (event) => {
  showResolved = event.target.checked;
  renderThreads();
});

$('#share-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentProject) return;
  const username = $('#share-username').value.trim();
  const role = $('#share-role').value;
  const error = $('#share-error');
  error.classList.add('hidden');
  try {
    await api('POST', `/projects/${currentProject.id}/shares`, { username, role });
    $('#share-username').value = '';
    projectShares = await api('GET', `/projects/${currentProject.id}/shares`);
    renderShares();
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
});

document.querySelectorAll('input[name="theme"]').forEach((input) => {
  input.addEventListener('change', () => {
    settings.theme = input.value;
    saveSettings();
    applySettings();
  });
});

$('#toggle-sync-view').addEventListener('change', (event) => {
  settings.syncView = event.target.checked;
  saveSettings();
});

$('#toggle-justify-preview').addEventListener('change', (event) => {
  settings.justifyPreview = event.target.checked;
  saveSettings();
  applySettings();
});

$('#btn-settings').addEventListener('click', () => toggleSettingsPanel());

document.addEventListener('click', (event) => {
  const shell = document.querySelector('.settings-shell');
  if (shell && !shell.contains(event.target)) toggleSettingsPanel(false);
});

marked.setOptions({
  breaks: true,
  gfm: true,
  headerIds: false,
  mangle: false
});

initSelectionListener();
initPreviewClickNavigation();
applyTheme(settings.theme);
bootstrap();
