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
  editing: false,
  showResolved: false,
  currentView: 'dashboard',
  previewTimer: null,
  mathPlaceholders: {},
  placeholderCounter: 0,
  settings: loadSettings(),
  activeSidePanel: 'none',
  sidePanelResize: null,
  syncingScroll: false,
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
  const editor = $('#editor');
  editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
  editor.focus();
  markEditorChanged();
}

function markEditorChanged() {
  state.editing = true;
  updateEditorPermissions();
  if (window.App && window.App.preview.schedulePreview) {
    window.App.preview.schedulePreview();
  }
}

function canEditCurrentProject() {
  return !!state.currentProject && ['owner', 'editor'].includes(state.currentProject.accessRole);
}

function canCommentCurrentProject() {
  return !!state.currentProject && !!state.currentFile;
}

function canManageShares() {
  return !!state.currentProject && state.currentProject.isOwner;
}

function holdsCurrentLock() {
  return !!state.currentProject && !!state.currentUser && state.currentProject.lockOwnerId === state.currentUser.id;
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
    return;
  }

  title.textContent = state.currentFile
    ? `${state.currentProject.title} / ${state.currentFile.filePath}`
    : state.currentProject.title;
  roleBadge.textContent = capitalize(state.currentProject.accessRole);
  roleBadge.classList.remove('hidden');
  if (state.currentProject.lockOwnerId) {
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
}

function updateEditorPermissions() {
  const canEdit = canEditCurrentProject();
  const lockDisabled = !state.currentProject || !canEdit || (!!state.currentProject.lockOwnerId && !holdsCurrentLock());
  const saveEnabled = !!state.currentFile && canEdit && holdsCurrentLock() && state.editing;
  $('#btn-save').disabled = !saveEnabled;
  $('#btn-lock').disabled = lockDisabled;
  $('#btn-upload-image').disabled = !state.currentFile || !canEdit || !holdsCurrentLock();
  $('#editor').readOnly = !state.currentFile || !canEdit || !holdsCurrentLock();
  if (!state.currentProject || !canEdit) {
    $('#btn-lock').textContent = 'Lock';
  } else if (holdsCurrentLock()) {
    $('#btn-lock').textContent = 'Unlock';
  } else if (state.currentProject.lockOwnerId) {
    $('#btn-lock').textContent = 'Locked';
  } else {
    $('#btn-lock').textContent = 'Lock';
  }
  if (window.App.findReplace && window.App.findReplace.refreshMatches) {
    window.App.findReplace.refreshMatches($('#editor').selectionStart, 'forward');
  }
}

function resetEditorState() {
  state.currentFile = null;
  $('#editor').value = '';
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
    canManageShares,
    capitalize,
    closeSidePanel,
    clearStoredIdentifier,
    closePanels,
    clampSidePanelWidth,
    currentCommentContext,
    esc,
    formatDate,
    getStoredIdentifier,
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
  projects: {}
};

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
    await uploadProjectAsset(state.currentProject.id, file, dirPath.trim());
    await window.App.projects.refreshProjectState();
  });

  $('#editor').addEventListener('input', () => {
    markEditorChanged();
  });

  $('#editor').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      $('#btn-save').click();
    }
    if (event.key === 'Tab' && !$('#editor').readOnly) {
      event.preventDefault();
      const editor = $('#editor');
      editor.setRangeText('    ', editor.selectionStart, editor.selectionEnd, 'end');
      markEditorChanged();
    }
  });

  $('#editor').addEventListener('scroll', () => window.App.preview.syncScroll($('#editor'), $('#preview')));
  $('#preview').addEventListener('scroll', () => window.App.preview.syncScroll($('#preview'), $('#editor')));

  $('#btn-save').addEventListener('click', async () => {
    if (!state.currentProject || !state.currentFile) return;
    state.currentFile = await api('PUT', `/projects/${state.currentProject.id}/files/content`, {
      path: state.currentFile.filePath,
      content: $('#editor').value
    });
    state.editing = false;
    await window.App.projects.refreshProjectState(state.currentFile.filePath);
    window.App.preview.updatePreview();
  });

  $('#btn-lock').addEventListener('click', async () => {
    if (!state.currentProject || !canEditCurrentProject()) return;
    if (holdsCurrentLock()) {
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
    await window.App.projects.loadVersions();
  });

  $('#btn-close-review').addEventListener('click', closeSidePanel);

  $('#version-select-base').addEventListener('change', (event) => {
    state.selectedBaseId = event.target.value;
  });

  $('#version-select-head').addEventListener('change', (event) => {
    state.selectedHeadId = event.target.value;
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
    wireEvents();
    applyTheme(state.settings.theme);
    applySettings();
    if (window.App.findReplace && window.App.findReplace.bindEvents) {
      window.App.findReplace.bindEvents();
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
