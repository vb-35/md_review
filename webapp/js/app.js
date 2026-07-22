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
const SETTINGS_KEY_VIEW_MODE = 'md-review.view-mode';
const SETTINGS_KEY_REPLACE_SHORTCUT = 'md-review.replace-shortcut';
const SETTINGS_KEY_FONT_SIZE = 'md-review.font-size';
const SETTINGS_KEY_SIDE_PANEL_WIDTH = 'md-review.side-panel-width';
const AUTH_KEY_IDENTIFIER = 'md-review.identifier';
const HIGHLIGHT_THEME_DARK = 'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css';
const HIGHLIGHT_THEME_LIGHT = 'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css';
const SIDE_PANEL_DEFAULT_WIDTH = 420;
const SIDE_PANEL_MIN_WIDTH = 280;
const SIDE_PANEL_MIN_MAIN_WIDTH = 320;
let resolveEditorReady;
const editorReady = new Promise((resolve) => {
  resolveEditorReady = resolve;
});

function focusWithoutScroll(element) {
  if (!element) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function createFallbackEditorAdapter() {
  let textarea = null;
  const changeCallbacks = new Set();
  const scrollCallbacks = new Set();
  let searchQuery = '';
  let searchReplacement = '';

  function ensureTextarea(container) {
    if (textarea) return textarea;
    textarea = document.createElement('textarea');
    textarea.id = 'editor-fallback';
    textarea.spellcheck = false;
    textarea.style.flex = '1';
    textarea.style.width = '100%';
    textarea.style.height = '100%';
    textarea.style.resize = 'none';
    textarea.style.border = 'none';
    textarea.style.outline = 'none';
    textarea.style.padding = '18px';
    textarea.style.margin = '0';
    textarea.style.fontFamily = '"IBM Plex Mono", "Fira Code", monospace';
    textarea.style.fontSize = 'var(--workspace-font-size)';
    textarea.style.lineHeight = '1.6';
    textarea.style.color = 'var(--fg)';
    textarea.style.background = 'transparent';
    textarea.style.boxSizing = 'border-box';
    textarea.addEventListener('input', () => {
      const payload = {
        docChanged: true,
        selectionSet: false,
        focusChanged: false,
        viewportChanged: false,
        value: textarea.value,
        selection: fallbackEditor.getSelection()
      };
      changeCallbacks.forEach((callback) => callback(payload));
    });
    textarea.addEventListener('keyup', () => {
      const payload = {
        docChanged: false,
        selectionSet: true,
        focusChanged: false,
        viewportChanged: false,
        value: textarea.value,
        selection: fallbackEditor.getSelection()
      };
      changeCallbacks.forEach((callback) => callback(payload));
    });
    textarea.addEventListener('click', () => {
      const payload = {
        docChanged: false,
        selectionSet: true,
        focusChanged: false,
        viewportChanged: false,
        value: textarea.value,
        selection: fallbackEditor.getSelection()
      };
      changeCallbacks.forEach((callback) => callback(payload));
    });
    textarea.addEventListener('scroll', () => {
      scrollCallbacks.forEach((callback) => callback(fallbackEditor.getScrollInfo()));
    });
    container.appendChild(textarea);
    return textarea;
  }

  function getMatches() {
    if (!searchQuery) return [];
    const text = textarea ? textarea.value : '';
    const matches = [];
    let cursor = 0;
    while (cursor <= text.length - searchQuery.length) {
      const index = text.indexOf(searchQuery, cursor);
      if (index === -1) break;
      matches.push({ from: index, to: index + searchQuery.length });
      cursor = index + searchQuery.length;
    }
    return matches;
  }

  const fallbackEditor = {
    init(container, initialValue = '') {
      const input = ensureTextarea(container);
      input.value = initialValue || '';
      return input;
    },
    getValue() {
      return textarea ? textarea.value : '';
    },
    setValue(value) {
      if (!textarea) return;
      textarea.value = value == null ? '' : String(value);
    },
    setEditable(isEditable) {
      if (!textarea) return;
      textarea.readOnly = !isEditable;
      textarea.style.color = isEditable ? 'var(--fg)' : 'var(--fg-dim)';
    },
    focus() {
      focusWithoutScroll(textarea);
    },
    getSelection() {
      const input = textarea;
      const from = input ? input.selectionStart : 0;
      const to = input ? input.selectionEnd : 0;
      return {
        anchor: from,
        head: to,
        from,
        to,
        text: input ? input.value.slice(from, to) : ''
      };
    },
    setSelection(anchor, head = anchor) {
      if (!textarea) return;
      focusWithoutScroll(textarea);
      textarea.setSelectionRange(anchor, head);
    },
    replaceSelection(text) {
      if (!textarea) return;
      textarea.setRangeText(String(text ?? ''), textarea.selectionStart, textarea.selectionEnd, 'end');
    },
    replaceRange(from, to, text) {
      if (!textarea) return;
      textarea.setRangeText(String(text ?? ''), from, to, 'end');
    },
    setCursor(offset) {
      if (!textarea) return;
      focusWithoutScroll(textarea);
      textarea.setSelectionRange(offset, offset);
    },
    revealOffset(offset) {
      if (!textarea) return;
      const before = textarea.value.slice(0, offset);
      const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 22;
      const line = before.split('\n').length - 1;
      textarea.scrollTop = Math.max(0, line * lineHeight - textarea.clientHeight / 2);
    },
    getScrollInfo() {
      if (!textarea) return { top: 0, scrollHeight: 0, clientHeight: 0, ratio: 0 };
      const range = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
      return {
        top: textarea.scrollTop,
        scrollHeight: textarea.scrollHeight,
        clientHeight: textarea.clientHeight,
        ratio: range > 0 ? textarea.scrollTop / range : 0
      };
    },
    scrollToRatio(ratio) {
      if (!textarea) return;
      const range = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
      textarea.scrollTop = Math.max(0, Math.min(1, ratio || 0)) * range;
    },
    onChange(callback) {
      changeCallbacks.add(callback);
      return () => changeCallbacks.delete(callback);
    },
    onScroll(callback) {
      scrollCallbacks.add(callback);
      return () => scrollCallbacks.delete(callback);
    },
    applyTheme() {},
    openSearchPanel() {},
    closeSearchPanel() {},
    setSearchQuery(query, replacement = '') {
      searchQuery = query || '';
      searchReplacement = replacement || '';
    },
    getSearchStatus() {
      const matches = getMatches();
      const selection = fallbackEditor.getSelection();
      let activeIndex = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
      if (activeIndex === -1 && matches.length) {
        activeIndex = matches.findIndex((match) => match.from >= selection.from);
        if (activeIndex === -1) activeIndex = 0;
      }
      return {
        query: searchQuery,
        replacement: searchReplacement,
        count: matches.length,
        activeIndex,
        matches
      };
    },
    findNext() {
      const status = fallbackEditor.getSearchStatus();
      if (!status.count) return false;
      const nextIndex = status.activeIndex < 0 ? 0 : (status.activeIndex + 1) % status.count;
      fallbackEditor.setSelection(status.matches[nextIndex].from, status.matches[nextIndex].to);
      return true;
    },
    findPrevious() {
      const status = fallbackEditor.getSearchStatus();
      if (!status.count) return false;
      const prevIndex = status.activeIndex < 0 ? status.count - 1 : (status.activeIndex - 1 + status.count) % status.count;
      fallbackEditor.setSelection(status.matches[prevIndex].from, status.matches[prevIndex].to);
      return true;
    },
    replaceNext() {
      if (!textarea || textarea.readOnly) return false;
      const status = fallbackEditor.getSearchStatus();
      if (!status.count || status.activeIndex < 0) return false;
      const match = status.matches[status.activeIndex];
      fallbackEditor.replaceRange(match.from, match.to, searchReplacement);
      fallbackEditor.setSelection(match.from, match.from + searchReplacement.length);
      return true;
    },
    replaceAll() {
      if (!textarea || textarea.readOnly || !searchQuery) return false;
      const matches = getMatches();
      if (!matches.length) return false;
      textarea.value = textarea.value.split(searchQuery).join(searchReplacement);
      return true;
    }
  };

  return fallbackEditor;
}

function ensureEditorReady() {
  const container = $('#editor-root');
  try {
    window.App.editor.init(container, '');
  } catch (error) {
    console.error('Editor initialization failed, falling back to plain textarea editor.', error);
    if (!window.App._usingFallbackEditor) {
      window.App.editor = createFallbackEditorAdapter();
      window.App._usingFallbackEditor = true;
    }
    window.App.editor.init(container, '');
  }
}

const $ = (sel) => document.querySelector(sel);

function loadSettings() {
  const theme = localStorage.getItem(SETTINGS_KEY_THEME);
  const viewMode = localStorage.getItem(SETTINGS_KEY_VIEW_MODE);
  const replaceShortcutKey = localStorage.getItem(SETTINGS_KEY_REPLACE_SHORTCUT);
  const fontSize = parseInt(localStorage.getItem(SETTINGS_KEY_FONT_SIZE) || '16', 10);
  const sidePanelWidth = parseInt(localStorage.getItem(SETTINGS_KEY_SIDE_PANEL_WIDTH) || String(SIDE_PANEL_DEFAULT_WIDTH), 10);
  return {
    theme: theme === 'light' ? 'light' : 'dark',
    syncView: localStorage.getItem(SETTINGS_KEY_SYNC_VIEW) === 'true',
    justifyPreview: localStorage.getItem(SETTINGS_KEY_JUSTIFY_PREVIEW) !== 'false',
    viewMode: ['view', 'both', 'edit'].includes(viewMode) ? viewMode : 'both',
    replaceShortcutKey: ['h', 'r'].includes(replaceShortcutKey) ? replaceShortcutKey : 'h',
    fontSize: [14, 16, 18, 20].includes(fontSize) ? fontSize : 16,
    sidePanelWidth: Number.isFinite(sidePanelWidth) ? sidePanelWidth : SIDE_PANEL_DEFAULT_WIDTH
  };
}

const state = {
  currentUser: null,
  currentProject: null,
  currentFile: null,
  projects: [],
  projectShares: [],
  projectFiles: [],
  selectedProjectId: null,
  versions: [],
  threads: [],
  selectedBaseId: null,
  selectedHeadId: null,
  comparedDiff: null,
  comparedDiffBaselineContent: '',
  comparedDiffDecisions: {},
  lastAppliedDiffAction: null,
  activeProposalReview: null,
  editing: false,
  showResolved: false,
  commentSort: 'activity-desc',
  currentView: 'dashboard',
  previewTimer: null,
  mathPlaceholders: {},
  placeholderCounter: 0,
  settings: loadSettings(),
  activeSidePanel: 'none',
  sidePanelResize: null,
  lockHeartbeatTimer: null,
  lockHeartbeatProjectId: null,
  proposals: [],
  currentProposal: null,
  syncingScroll: false,
  suspendEditorChangeTracking: false,
  initialized: false
};

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY_THEME, state.settings.theme);
  localStorage.setItem(SETTINGS_KEY_SYNC_VIEW, String(state.settings.syncView));
  localStorage.setItem(SETTINGS_KEY_JUSTIFY_PREVIEW, String(state.settings.justifyPreview));
  localStorage.setItem(SETTINGS_KEY_VIEW_MODE, state.settings.viewMode);
  localStorage.setItem(SETTINGS_KEY_REPLACE_SHORTCUT, state.settings.replaceShortcutKey);
  localStorage.setItem(SETTINGS_KEY_FONT_SIZE, String(state.settings.fontSize));
  localStorage.setItem(SETTINGS_KEY_SIDE_PANEL_WIDTH, String(state.settings.sidePanelWidth));
}

function applyViewMode(mode) {
  const viewMode = ['view', 'both', 'edit'].includes(mode) ? mode : 'both';
  const splitView = $('#split-view');
  if (splitView) splitView.dataset.viewMode = viewMode;
  document.querySelectorAll('[data-view-mode]').forEach((button) => {
    const active = button.dataset.viewMode === viewMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function isMobileSidePanelLayout() {
  return window.innerWidth <= 768;
}

function clampSidePanelWidth(width) {
  const splitView = $('#split-view');
  const parsedWidth = Number.isFinite(width) ? width : SIDE_PANEL_DEFAULT_WIDTH;
  if (!splitView) return Math.max(SIDE_PANEL_MIN_WIDTH, parsedWidth);
  const visibleMainPanes = state.settings.viewMode === 'both' ? 2 : 1;
  const maxWidth = splitView.clientWidth - (visibleMainPanes * SIDE_PANEL_MIN_MAIN_WIDTH);
  if (maxWidth <= SIDE_PANEL_MIN_WIDTH) return SIDE_PANEL_MIN_WIDTH;
  return Math.min(Math.max(parsedWidth, SIDE_PANEL_MIN_WIDTH), maxWidth);
}

function applySidePanelLayout() {
  const splitView = $('#split-view');
  const sideRail = $('#side-rail');
  const resizer = $('#side-panel-resizer');
  if (!splitView || !sideRail || !resizer) return;
  const activePanel = state.activeSidePanel;
  const isOpen = activePanel !== 'none';
  const isMobile = isMobileSidePanelLayout();
  const width = clampSidePanelWidth(state.settings.sidePanelWidth);
  state.settings.sidePanelWidth = width;
  splitView.style.setProperty('--side-panel-width', `${width}px`);
  splitView.dataset.sidePanelOpen = isOpen ? 'true' : 'false';
  splitView.dataset.sidePanel = activePanel;
  sideRail.dataset.activePanel = activePanel;
  sideRail.classList.toggle('hidden', !isOpen);
  resizer.classList.toggle('hidden', !isOpen || isMobile);
  $('#review-panel').classList.toggle('hidden', activePanel !== 'review');
  $('#comments-panel').classList.toggle('hidden', activePanel !== 'comments');
}

function openSidePanel(panelName) {
  state.activeSidePanel = panelName === 'review' || panelName === 'comments' ? panelName : 'none';
  applySidePanelLayout();
}

function closeSidePanel() {
  state.activeSidePanel = 'none';
  applySidePanelLayout();
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  const highlightTheme = $('#highlight-theme');
  if (highlightTheme) {
    highlightTheme.href = theme === 'light' ? HIGHLIGHT_THEME_LIGHT : HIGHLIGHT_THEME_DARK;
  }
  if (window.App && window.App.editor && window.App.editor.applyTheme) {
    window.App.editor.applyTheme(theme);
  }
}

function applyFontSize(fontSize) {
  const normalized = [14, 16, 18, 20].includes(fontSize) ? fontSize : 16;
  document.documentElement.style.setProperty('--workspace-font-size', `${normalized}px`);
}

function applySettings() {
  applyTheme(state.settings.theme);
  applyViewMode(state.settings.viewMode);
  applyFontSize(state.settings.fontSize);
  const syncToggle = $('#toggle-sync-view');
  if (syncToggle) syncToggle.checked = state.settings.syncView;
  const justifyToggle = $('#toggle-justify-preview');
  if (justifyToggle) justifyToggle.checked = state.settings.justifyPreview;
  const replaceShortcutSelect = $('#replace-shortcut-select');
  if (replaceShortcutSelect) replaceShortcutSelect.value = state.settings.replaceShortcutKey;
  const fontSizeSelect = $('#font-size-select');
  if (fontSizeSelect) fontSizeSelect.value = String(state.settings.fontSize);
  document.body.classList.toggle('preview-justify-disabled', !state.settings.justifyPreview);
  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    input.checked = input.value === state.settings.theme;
  });
  applySidePanelLayout();
}

function toggleSettingsPanel(forceOpen) {
  const panel = $('#settings-panel');
  const button = $('#btn-settings');
  if (!panel || !button) return;
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !shouldOpen);
  button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
}

function headers() {
  return { 'Content-Type': 'application/json' };
}

function getStoredIdentifier() {
  return localStorage.getItem(AUTH_KEY_IDENTIFIER) || '';
}

function storeIdentifier(username) {
  localStorage.setItem(AUTH_KEY_IDENTIFIER, username);
}

function clearStoredIdentifier() {
  localStorage.removeItem(AUTH_KEY_IDENTIFIER);
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

async function uploadProjectArchive(file, title = '') {
  const body = new FormData();
  body.append('file', file);
  if (title) body.append('title', title);
  const res = await fetch(API + '/projects/import-archive', {
    method: 'POST',
    credentials: 'include',
    body
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await res.json()
    : { error: 'Expected JSON response from archive import' };
  if (!res.ok) throw new Error(data.error || 'Archive import failed');
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

function insertAtCursor(text) {
  window.App.editor.replaceSelection(text);
  window.App.editor.focus();
}

function markEditorChanged() {
  state.editing = true;
  updateSaveButton();
  if (window.App && window.App.preview.schedulePreview) {
    window.App.preview.schedulePreview();
  }
}

function canEditCurrentProject() {
  return !!state.currentProject && ['owner', 'admin', 'editor'].includes(state.currentProject.accessRole);
}

function canCommentCurrentProject() {
  return !!state.currentProject && !!state.currentFile;
}

function canManageShares() {
  return !!state.currentProject && ['owner', 'admin'].includes(state.currentProject.accessRole);
}

function canDeleteProjectFiles() {
  return !!state.currentProject && ['owner', 'admin'].includes(state.currentProject.accessRole);
}

function hasActiveProjectLock(project = state.currentProject) {
  if (!project || !project.lockOwnerId || !project.lockExpiresAt) return false;
  const expiresAt = Date.parse(project.lockExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function holdsCurrentLock() {
  return hasActiveProjectLock() && !!state.currentUser && state.currentProject.lockOwnerId === state.currentUser.id;
}

function currentCommentContext() {
  if (!state.currentProject || !state.currentFile || !state.currentProject.currentCommitSha) return null;
  return {
    projectId: state.currentProject.id,
    filePath: state.currentFile.filePath,
    commitSha: state.currentProject.currentCommitSha
  };
}

function closePanels() {
  closeSidePanel();
}

function startSidePanelResize(event) {
  if (isMobileSidePanelLayout() || state.activeSidePanel === 'none') return;
  event.preventDefault();
  state.sidePanelResize = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: clampSidePanelWidth(state.settings.sidePanelWidth)
  };
  document.body.classList.add('is-resizing-side-panel');
}

function handleSidePanelResize(event) {
  if (!state.sidePanelResize) return;
  const delta = state.sidePanelResize.startX - event.clientX;
  state.settings.sidePanelWidth = clampSidePanelWidth(state.sidePanelResize.startWidth + delta);
  applySidePanelLayout();
}

function stopSidePanelResize(event) {
  if (!state.sidePanelResize) return;
  if (event && typeof event.pointerId === 'number' && state.sidePanelResize.pointerId !== event.pointerId) return;
  state.sidePanelResize = null;
  document.body.classList.remove('is-resizing-side-panel');
  saveSettings();
}

function showTopbar() {
  $('#topbar').classList.remove('hidden');
  $('#user-display').textContent = state.currentUser.username;
}

function showLoginScreen(message = '') {
  $('#topbar').classList.add('hidden');
  $('#dashboard-screen').classList.add('hidden');
  $('#editor-screen').classList.add('hidden');
  closePanels();
  $('#login-screen').classList.remove('hidden');
  const hint = $('#login-hint');
  const error = $('#login-error');
  hint.textContent = message || 'Enter any identifier for this browser.';
  hint.classList.remove('hidden');

  error.classList.add('hidden');
  error.textContent = '';
  $('#login-username').value = getStoredIdentifier();
}

function showDashboard() {
  state.currentView = 'dashboard';
  $('#login-screen').classList.add('hidden');
  $('#editor-screen').classList.add('hidden');
  $('#dashboard-screen').classList.remove('hidden');
  closePanels();
  updateHeader();
}

function showEditor() {
  state.currentView = 'editor';
  $('#login-screen').classList.add('hidden');
  $('#dashboard-screen').classList.add('hidden');
  $('#editor-screen').classList.remove('hidden');
  updateHeader();
}

function updateHeader() {
  const title = $('#doc-title');
  const roleBadge = $('#doc-role-badge');
  const lockBadge = $('#lock-badge');
  if (!state.currentProject) {
    title.textContent = state.currentView === 'dashboard' ? 'Projects Dashboard' : '';
    roleBadge.classList.add('hidden');
    lockBadge.classList.add('hidden');
    $('#btn-save').disabled = true;
    $('#btn-lock').disabled = true;
    $('#btn-review').disabled = true;
    $('#btn-threads').disabled = true;
    $('#btn-menu').textContent = 'Projects';
    syncLockHeartbeat();
    return;
  }

  title.textContent = state.currentFile
    ? `${state.currentProject.title} / ${state.currentFile.filePath}`
    : state.currentProject.title;
  roleBadge.textContent = capitalize(state.currentProject.accessRole);
  roleBadge.classList.remove('hidden');
  if (hasActiveProjectLock()) {
    lockBadge.textContent = holdsCurrentLock()
      ? 'Locked by you'
      : `Locked by ${state.currentProject.lockOwnerUsername || 'another user'}`;
    lockBadge.classList.remove('hidden');
  } else {
    lockBadge.classList.add('hidden');
  }
  updateEditorPermissions();
  $('#btn-review').disabled = !state.currentFile;
  $('#btn-threads').disabled = !state.currentFile;
  $('#btn-menu').textContent = state.currentView === 'editor' ? 'Back to Projects' : 'Projects';
  syncLockHeartbeat();
}

function updateEditorPermissions() {
  const canEdit = canEditCurrentProject();
  const lockDisabled = !state.currentProject || !canEdit || (hasActiveProjectLock() && !holdsCurrentLock());
  updateSaveButton();
  $('#btn-lock').disabled = lockDisabled;
  $('#btn-upload-image').disabled = !state.currentFile || !canEdit || !holdsCurrentLock();
  if (window.App.editor && window.App.editor.setEditable) {
    window.App.editor.setEditable(!!state.currentFile && canEdit && holdsCurrentLock());
  }
  if (!state.currentProject || !canEdit) {
    $('#btn-lock').textContent = 'Lock';
  } else if (holdsCurrentLock()) {
    $('#btn-lock').textContent = 'Unlock';
  } else if (hasActiveProjectLock()) {
    $('#btn-lock').textContent = 'Locked';
  } else {
    $('#btn-lock').textContent = 'Lock';
  }
  if (window.App.findReplace && window.App.findReplace.refreshStatus) {
    window.App.findReplace.refreshStatus();
  }
}

function updateSaveButton() {
  const saveEnabled = !!state.currentFile
    && canEditCurrentProject()
    && holdsCurrentLock()
    && state.editing;
  $('#btn-save').disabled = !saveEnabled;
}

function stopLockHeartbeat() {
  if (state.lockHeartbeatTimer) clearInterval(state.lockHeartbeatTimer);
  state.lockHeartbeatTimer = null;
  state.lockHeartbeatProjectId = null;
}

function syncLockHeartbeat() {
  const projectId = state.currentProject && state.currentProject.id;
  const shouldRun = !!projectId && holdsCurrentLock();
  if (!shouldRun) {
    stopLockHeartbeat();
    return;
  }
  if (state.lockHeartbeatTimer && state.lockHeartbeatProjectId === projectId) return;
  stopLockHeartbeat();
  state.lockHeartbeatProjectId = projectId;
  state.lockHeartbeatTimer = setInterval(async () => {
    if (!state.currentProject || state.currentProject.id !== projectId || !holdsCurrentLock()) {
      stopLockHeartbeat();
      return;
    }
    try {
      const project = await api('POST', `/projects/${projectId}/lock/heartbeat`);
      if (state.currentProject && state.currentProject.id === projectId) {
        state.currentProject = project;
        updateHeader();
      }
    } catch {
      stopLockHeartbeat();
      if (state.currentProject && state.currentProject.id === projectId && window.App.projects.refreshProjectState) {
        await window.App.projects.refreshProjectState(state.currentFile ? state.currentFile.filePath : null);
      }
    }
  }, 60000);
}

function resetEditorState() {
  state.currentFile = null;
  state.suspendEditorChangeTracking = true;
  window.App.editor.setValue('');
  state.suspendEditorChangeTracking = false;
  $('#editor-file-label').textContent = 'Source';
  $('#preview').innerHTML = '';
  if (window.App.findReplace && window.App.findReplace.closeToolbar) {
    window.App.findReplace.closeToolbar();
  }
  state.editing = false;
  state.versions = [];
  state.threads = [];
  state.selectedBaseId = null;
  state.selectedHeadId = null;
  state.comparedDiff = null;
  state.comparedDiffBaselineContent = '';
  state.comparedDiffDecisions = {};
  state.lastAppliedDiffAction = null;
  state.activeProposalReview = null;
  state.activeSidePanel = 'none';
  closePanels();
}

window.App = {
  $,
  api,
  headers,
  state,
  uploadProjectAsset,
  constants: {
    API,
    HIGHLIGHT_THEME_DARK,
    HIGHLIGHT_THEME_LIGHT
  },
  helpers: {
    applySettings,
    applyFontSize,
    applyTheme,
    applySidePanelLayout,
    applyViewMode,
    canCommentCurrentProject,
    canEditCurrentProject,
    canDeleteProjectFiles,
    canManageShares,
    capitalize,
    closeSidePanel,
    clearStoredIdentifier,
    closePanels,
    clampSidePanelWidth,
    currentCommentContext,
    esc,
    formatDate,
    focusWithoutScroll,
    getStoredIdentifier,
    hasActiveProjectLock,
    holdsCurrentLock,
    isMobileSidePanelLayout,
    insertAtCursor,
    loadSettings,
    markEditorChanged,
    openSidePanel,
    resetEditorState,
    saveSettings,
    showDashboard,
    showEditor,
    showLoginScreen,
    showTopbar,
    storeIdentifier,
    toggleSettingsPanel,
    updateEditorPermissions,
    updateHeader
  },
  preview: {},
  comments: {},
  proposals: {},
  projects: {}
};

window.App.editorReady = editorReady;
window.App._resolveEditorReady = resolveEditorReady;
if (!window.App.editor) {
  window.App.editor = createFallbackEditorAdapter();
  window.App._usingFallbackEditor = true;
}

function wireEvents() {
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = $('#login-username').value.trim();
    try {
      const payload = await api('POST', '/auth/login', { username });
      storeIdentifier(username);
      state.currentUser = payload.user;
      showTopbar();
      showDashboard();
      await window.App.projects.loadProjects();
    } catch (error) {
      $('#login-error').textContent = error.message;
      $('#login-error').classList.remove('hidden');
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    await api('POST', '/auth/logout');
    clearStoredIdentifier();
    state.currentUser = null;
    state.currentProject = null;
    stopLockHeartbeat();
    resetEditorState();
    showLoginScreen();
  });

  $('#btn-menu').addEventListener('click', async () => {
    if (state.currentView === 'editor' && state.editing && !window.confirm('Discard unsaved changes and return to the projects dashboard?')) {
      return;
    }
    resetEditorState();
    showDashboard();
    if (state.currentProject) {
      await window.App.projects.refreshProjectState();
    }
  });

  $('#btn-new-project').addEventListener('click', async () => {
    const title = window.prompt('Project name');
    if (!title) return;
    const project = await api('POST', '/projects', { title });
    await window.App.projects.loadProjects();
    await window.App.projects.openProjectDetail(project.id);
  });

  $('#btn-import-repo').addEventListener('click', async () => {
    const repositoryUrl = window.prompt('Repository URL (HTTPS or SSH)');
    if (!repositoryUrl) return;
    const title = window.prompt('Project name (leave blank to use the repository name)', '');
    if (title === null) return;
    const button = $('#btn-import-repo');
    button.disabled = true;
    button.textContent = 'Importing…';
    try {
      const project = await api('POST', '/projects/import', {
        repositoryUrl: repositoryUrl.trim(),
        title: title.trim()
      });
      await window.App.projects.loadProjects();
      await window.App.projects.openProjectDetail(project.id);
    } catch (error) {
      window.alert(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Import Repo';
    }
  });

  $('#btn-import-archive').addEventListener('click', () => {
    $('#import-archive-input').click();
  });

  $('#import-archive-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const title = window.prompt('Project name (leave blank to use the archive name)', '');
    if (title === null) return;
    const button = $('#btn-import-archive');
    button.disabled = true;
    button.textContent = 'Importing…';
    try {
      const project = await uploadProjectArchive(file, title.trim());
      await window.App.projects.loadProjects();
      await window.App.projects.openProjectDetail(project.id);
    } catch (error) {
      window.alert(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Import Archive';
    }
  });

  $('#btn-delete-doc').addEventListener('click', async () => {
    if (!state.currentProject || !window.confirm('Delete this project?')) return;
    await api('DELETE', `/projects/${state.currentProject.id}`);
    state.currentProject = null;
    state.selectedProjectId = null;
    resetEditorState();
    await window.App.projects.loadProjects();
    $('#doc-detail').classList.add('hidden');
    $('#doc-detail-empty').classList.remove('hidden');
    updateHeader();
  });

  $('#btn-download-repo').addEventListener('click', () => {
    window.App.projects.downloadProjectRepo();
  });

  $('#btn-new-file').addEventListener('click', async () => {
    if (!state.currentProject) return;
    if (!canEditCurrentProject()) return alert('Edit access required.');
    if (!holdsCurrentLock()) return alert('Take the project lock first.');
    const filePath = window.prompt('Markdown path', 'README.md');
    if (!filePath) return;
    await api('POST', `/projects/${state.currentProject.id}/files`, { path: filePath, content: '' });
    await window.App.projects.refreshProjectState(filePath);
  });

  $('#btn-upload-asset').addEventListener('click', () => $('#upload-asset-input').click());

  $('#upload-asset-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file || !state.currentProject) return;
    if (!canEditCurrentProject()) return alert('Edit access required.');
    if (!holdsCurrentLock()) return alert('Take the project lock first.');
    const dirPath = window.prompt('Upload into folder (blank for project root)', '') || '';
    const uploaded = await uploadProjectAsset(state.currentProject.id, file, dirPath.trim());
    if (state.currentFile) state.currentFile.currentCommitSha = uploaded.currentCommitSha;
    await window.App.projects.refreshProjectState();
  });

  $('#preview').addEventListener('scroll', () => window.App.preview.syncPreviewToEditor());

  $('#btn-save').addEventListener('click', async () => {
    if (!state.currentProject || !state.currentFile) return;
    const review = state.activeProposalReview;
    const payload = {
      path: state.currentFile.filePath,
      content: window.App.editor.getValue(),
      baseCommitSha: state.currentFile.currentCommitSha
    };
    if (review && review.filePath === state.currentFile.filePath && review.needsSave) {
      payload.proposalId = review.proposalId;
    }
    state.currentFile = await api('PUT', `/projects/${state.currentProject.id}/files/content`, payload);
    state.activeProposalReview = null;
    state.editing = false;
    await window.App.projects.refreshProjectState(state.currentFile.filePath);
    window.App.preview.updatePreview();
  });

  $('#btn-lock').addEventListener('click', async () => {
    if (!state.currentProject || !canEditCurrentProject()) return;
    if (holdsCurrentLock()) {
      if (state.editing && !window.confirm("Discard unsaved changes and release the project lock?")) return;
      await api('DELETE', `/projects/${state.currentProject.id}/lock`);
    } else {
      await api('POST', `/projects/${state.currentProject.id}/lock`);
    }
    await window.App.projects.refreshProjectState(state.currentFile ? state.currentFile.filePath : null);
  });

  $('#btn-upload-image').addEventListener('click', () => $('#upload-image-input').click());

  $('#upload-image-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file || !state.currentProject || !state.currentFile) return;
    const currentDir = state.currentFile.filePath.includes('/')
      ? state.currentFile.filePath.split('/').slice(0, -1).join('/')
      : '';
    const uploaded = await uploadProjectAsset(state.currentProject.id, file, currentDir);
    state.currentFile.currentCommitSha = uploaded.currentCommitSha;
    state.currentProject.currentCommitSha = uploaded.currentCommitSha;
    insertAtCursor(`![${uploaded.filename}](${uploaded.url})`);
    window.App.preview.updatePreview();
  });

  $('#btn-review').addEventListener('click', async () => {
    if (!state.currentFile) return;
    if (state.activeSidePanel === 'review') {
      closeSidePanel();
      return;
    }
    openSidePanel('review');
    $('#btn-version-history-tab').click();
    await window.App.projects.loadVersions();
  });

  $('#btn-close-review').addEventListener('click', closeSidePanel);

  function selectVersionTab(tabName) {
    const canManage = !!(state.currentProject && state.currentProject.isOwner);
    const showManage = tabName === 'manage' && canManage;
    $('#version-history-view').classList.toggle('hidden', showManage);
    $('#version-manage-view').classList.toggle('hidden', !showManage);
    $('#btn-version-history-tab').setAttribute('aria-selected', showManage ? 'false' : 'true');
    $('#btn-version-manage-tab').setAttribute('aria-selected', showManage ? 'true' : 'false');
  }

  $('#btn-version-history-tab').addEventListener('click', () => selectVersionTab('history'));
  $('#btn-version-manage-tab').addEventListener('click', () => selectVersionTab('manage'));

  $('#version-select-base').addEventListener('change', (event) => {
    state.selectedBaseId = event.target.value;
  });

  $('#version-select-head').addEventListener('change', (event) => {
    state.selectedHeadId = event.target.value;
    window.App.projects.syncProposalBase(state.selectedHeadId);
  });

  $('#btn-compare').addEventListener('click', window.App.projects.compareSelectedVersions);
  $('#btn-revert').addEventListener('click', window.App.projects.revertSelectedVersion);

  $('#btn-threads').addEventListener('click', async () => {
    if (!state.currentFile) return;
    if (state.activeSidePanel === 'comments') {
      closeSidePanel();
      return;
    }
    openSidePanel('comments');
    await window.App.comments.loadThreads();
  });

  $('#btn-close-comments').addEventListener('click', closeSidePanel);
  $('#btn-add-thread').addEventListener('click', window.App.comments.createThread);
  $('#show-resolved').addEventListener('change', (event) => {
    state.showResolved = event.target.checked;
    window.App.comments.renderThreads();
  });
  $('#comment-sort').addEventListener('change', (event) => {
    state.commentSort = event.target.value;
    window.App.comments.renderThreads();
  });

  $('#side-panel-resizer').addEventListener('pointerdown', startSidePanelResize);
  window.addEventListener('pointermove', handleSidePanelResize);
  window.addEventListener('pointerup', stopSidePanelResize);
  window.addEventListener('pointercancel', stopSidePanelResize);
  window.addEventListener('resize', applySidePanelLayout);

  $('#share-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.currentProject) return;
    const username = $('#share-username').value.trim();
    const role = $('#share-role').value;
    const error = $('#share-error');
    error.classList.add('hidden');
    try {
      await api('POST', `/projects/${state.currentProject.id}/shares`, { username, role });
      $('#share-username').value = '';
      state.projectShares = await api('GET', `/projects/${state.currentProject.id}/shares`);
      window.App.projects.renderShares();
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  });

  document.querySelectorAll('input[name="theme"]').forEach((input) => {
    input.addEventListener('change', () => {
      state.settings.theme = input.value;
      saveSettings();
      applySettings();
    });
  });

  $('#toggle-sync-view').addEventListener('change', (event) => {
    state.settings.syncView = event.target.checked;
    saveSettings();
  });

  $('#toggle-justify-preview').addEventListener('change', (event) => {
    state.settings.justifyPreview = event.target.checked;
    saveSettings();
    applySettings();
  });

  $('#replace-shortcut-select').addEventListener('change', (event) => {
    state.settings.replaceShortcutKey = event.target.value === 'r' ? 'r' : 'h';
    saveSettings();
    applySettings();
  });

  $('#font-size-select').addEventListener('change', (event) => {
    const fontSize = parseInt(event.target.value, 10);
    state.settings.fontSize = [14, 16, 18, 20].includes(fontSize) ? fontSize : 16;
    saveSettings();
    applySettings();
  });

  document.querySelectorAll('[data-view-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.settings.viewMode = button.dataset.viewMode || 'both';
      saveSettings();
      applyViewMode(state.settings.viewMode);
      applySidePanelLayout();
    });
  });

  $('#btn-settings').addEventListener('click', () => toggleSettingsPanel());

  document.addEventListener('click', (event) => {
    const shell = document.querySelector('.settings-shell');
    if (shell && !shell.contains(event.target)) toggleSettingsPanel(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && window.App.findReplace && $('#find-replace-bar') && !$('#find-replace-bar').classList.contains('hidden')) {
      event.preventDefault();
      window.App.findReplace.closeToolbar();
      return;
    }
    if (window.App.findReplace) {
      window.App.findReplace.handleGlobalShortcut(event);
    }
  });
}

async function bootstrap() {
  if (!state.initialized) {
    state.initialized = true;
    marked.setOptions({
      breaks: true,
      gfm: true,
      headerIds: false,
      mangle: false
    });
    ensureEditorReady();
    window.App.editor.onChange((update) => {
      if (window.App.findReplace && window.App.findReplace.handleEditorUpdate) {
        window.App.findReplace.handleEditorUpdate(update);
      }
      if (update.docChanged && !state.suspendEditorChangeTracking) {
        markEditorChanged();
      }
    });
    window.App.editor.onScroll(() => {
      window.App.preview.syncEditorToPreview();
    });
    wireEvents();
    applyTheme(state.settings.theme);
    applySettings();
    if (window.App.findReplace && window.App.findReplace.bindEvents) {
      window.App.findReplace.bindEvents();
    }
    if (window.App.comments && window.App.comments.bindComposerEvents) {
      window.App.comments.bindComposerEvents();
    }
    window.App.comments.initSelectionListener();
    window.App.preview.initPreviewClickNavigation();
  }

  try {
    const payload = await api('GET', '/auth/bootstrap');
    state.currentUser = payload.user;
    showTopbar();
    showDashboard();
    await window.App.projects.loadProjects();
  } catch (error) {
    const username = getStoredIdentifier().trim();
    if (username) {
      try {
        const payload = await api('POST', '/auth/login', { username });
        state.currentUser = payload.user;
        showTopbar();
        showDashboard();
        await window.App.projects.loadProjects();
        return;
      } catch {
        clearStoredIdentifier();
      }
    }
    showLoginScreen();
  }
}

window.App.bootstrap = bootstrap;
