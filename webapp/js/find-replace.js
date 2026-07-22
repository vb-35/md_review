(function (root) {
  const App = root.App;
  if (!App) return;

  const state = App.state;
  const $ = App.$;
  const { canEditCurrentProject, holdsCurrentLock } = App.helpers;

  state.findReplace = {
    open: false,
    mode: 'find',
    query: '',
    replacement: '',
    activeIndex: -1,
    count: 0
  };

  function isEditorScreenActive() {
    return state.currentView === 'editor' && !$('#editor-screen').classList.contains('hidden');
  }

  function isReplaceAllowed() {
    return !!state.currentFile && canEditCurrentProject() && holdsCurrentLock();
  }

  function readStatus() {
    const status = App.editor.getSearchStatus();
    state.findReplace.query = status.query;
    state.findReplace.replacement = status.replacement;
    state.findReplace.activeIndex = status.activeIndex;
    state.findReplace.count = status.count;
    return status;
  }

  function updateStatus(status = readStatus()) {
    $('#find-match-count').textContent = status.count
      ? `${status.activeIndex + 1} / ${status.count}`
      : '0 / 0';
    $('#btn-find-prev').disabled = status.count === 0;
    $('#btn-find-next').disabled = status.count === 0;
    $('#btn-replace-one').disabled = status.count === 0 || !isReplaceAllowed();
    $('#btn-replace-all').disabled = status.count === 0 || !isReplaceAllowed();
  }

  function syncSearchQuery() {
    state.findReplace.query = $('#find-input').value;
    state.findReplace.replacement = $('#replace-input').value;
    App.editor.setSearchQuery(state.findReplace.query, state.findReplace.replacement);
    return readStatus();
  }

  function focusActiveMatch(status) {
    if (!status.count || status.activeIndex < 0) return status;
    const activeMatch = status.matches[status.activeIndex];
    const selection = App.editor.getSelection();
    if (selection.from === activeMatch.from && selection.to === activeMatch.to) return status;
    App.editor.setSelection(activeMatch.from, activeMatch.to);
    App.editor.revealOffset(activeMatch.from);
    return readStatus();
  }

  function refreshMatches() {
    updateStatus(focusActiveMatch(syncSearchQuery()));
  }

  function refreshStatus() {
    updateStatus(readStatus());
  }

  function setMode(mode) {
    state.findReplace.mode = mode === 'replace' ? 'replace' : 'find';
    $('#find-replace-bar').dataset.mode = state.findReplace.mode;
    $('#find-replace-bar').classList.toggle('replace-mode', state.findReplace.mode === 'replace');
  }

  function openToolbar(mode) {
    if (!isEditorScreenActive() || !state.currentFile) return false;
    setMode(mode);
    const bar = $('#find-replace-bar');
    bar.classList.remove('hidden');
    state.findReplace.open = true;
    $('#find-input').value = state.findReplace.query || '';
    $('#replace-input').value = state.findReplace.replacement || '';
    App.editor.openSearchPanel();
    refreshMatches();
    App.helpers.focusWithoutScroll($('#find-input'));
    $('#find-input').select();
    return true;
  }

  function closeToolbar() {
    $('#find-replace-bar').classList.add('hidden');
    state.findReplace.open = false;
    state.findReplace.activeIndex = -1;
    state.findReplace.count = 0;
    App.editor.closeSearchPanel();
    App.editor.focus();
    updateStatus({
      count: 0,
      activeIndex: -1
    });
  }

  function jump(direction) {
    if (!state.findReplace.count) return;
    if (direction === 'backward') {
      App.editor.findPrevious();
    } else {
      App.editor.findNext();
    }
    updateStatus(readStatus());
  }

  function replaceCurrent() {
    if (!isReplaceAllowed()) return;
    syncSearchQuery();
    if (!App.editor.replaceNext()) return;
    updateStatus(readStatus());
  }

  function replaceAllMatches() {
    if (!isReplaceAllowed()) return;
    syncSearchQuery();
    if (!App.editor.replaceAll()) return;
    updateStatus(readStatus());
  }

  function handleGlobalShortcut(event) {
    if (!isEditorScreenActive() || !state.currentFile) return false;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
    const key = (event.key || '').toLowerCase();
    if (key === 'f') {
      event.preventDefault();
      return openToolbar('find');
    }
    if (key === state.settings.replaceShortcutKey) {
      event.preventDefault();
      return openToolbar('replace');
    }
    return false;
  }

  function handleEditorUpdate(update) {
    if (!state.findReplace.open) return;
    if (!update.docChanged && !update.selectionSet) return;
    updateStatus(readStatus());
  }

  function bindEvents() {
    $('#find-input').addEventListener('input', () => {
      refreshMatches();
      App.helpers.focusWithoutScroll($('#find-input'));
    });
    $('#replace-input').addEventListener('input', () => {
      refreshMatches();
      App.helpers.focusWithoutScroll($('#replace-input'));
    });
    $('#btn-find-prev').addEventListener('click', () => jump('backward'));
    $('#btn-find-next').addEventListener('click', () => jump('forward'));
    $('#btn-replace-one').addEventListener('click', replaceCurrent);
    $('#btn-replace-all').addEventListener('click', replaceAllMatches);
    $('#btn-find-close').addEventListener('click', closeToolbar);
    $('#find-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        jump(event.shiftKey ? 'backward' : 'forward');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeToolbar();
      }
    });
    $('#replace-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        replaceCurrent();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeToolbar();
      }
    });
  }

  App.findReplace = {
    bindEvents,
    closeToolbar,
    handleEditorUpdate,
    handleGlobalShortcut,
    openToolbar,
    refreshMatches,
    refreshStatus
  };
})(typeof window !== 'undefined' ? window : globalThis);
