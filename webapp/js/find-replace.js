(function (root) {
  function findMatches(text, query) {
    if (!query) return [];
    const matches = [];
    let index = 0;
    while (index <= text.length - query.length) {
      const foundAt = text.indexOf(query, index);
      if (foundAt === -1) break;
      matches.push({
        start: foundAt,
        end: foundAt + query.length
      });
      index = foundAt + query.length;
    }
    return matches;
  }

  function getActiveMatchIndex(matches, selectionStart, direction = 'forward') {
    if (!matches.length) return -1;
    if (direction === 'backward') {
      for (let index = matches.length - 1; index >= 0; index -= 1) {
        if (matches[index].start < selectionStart) return index;
      }
      return matches.length - 1;
    }
    for (let index = 0; index < matches.length; index += 1) {
      if (matches[index].start >= selectionStart) return index;
    }
    return 0;
  }

  function replaceMatch(text, match, replacement) {
    if (!match) return text;
    return `${text.slice(0, match.start)}${replacement}${text.slice(match.end)}`;
  }

  function replaceAllMatches(text, query, replacement) {
    if (!query) {
      return { text, count: 0 };
    }
    const matches = findMatches(text, query);
    if (!matches.length) {
      return { text, count: 0 };
    }
    let cursor = 0;
    let output = '';
    for (const match of matches) {
      output += text.slice(cursor, match.start);
      output += replacement;
      cursor = match.end;
    }
    output += text.slice(cursor);
    return {
      text: output,
      count: matches.length
    };
  }

  const api = {
    findMatches,
    getActiveMatchIndex,
    replaceAllMatches,
    replaceMatch
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  const App = root.App;
  if (!App) return;
  const state = App.state;
  const $ = App.$;

  state.findReplace = {
    open: false,
    mode: 'find',
    query: '',
    replacement: '',
    matches: [],
    activeIndex: -1
  };

  function getEditor() {
    return $('#editor');
  }

  function getHighlightOverlay() {
    return $('#editor-find-highlight');
  }

  function isEditorScreenActive() {
    return state.currentView === 'editor' && !$('#editor-screen').classList.contains('hidden');
  }

  function revealSelection(editor, start) {
    const before = editor.value.slice(0, start);
    const lineNumber = before.split('\n').length;
    const lineHeight = parseFloat(root.getComputedStyle(editor).lineHeight) || 22;
    const top = Math.max(0, (lineNumber - 1) * lineHeight - lineHeight * 2);
    const bottom = top + lineHeight * 4;
    if (top < editor.scrollTop) {
      editor.scrollTop = top;
    } else if (bottom > editor.scrollTop + editor.clientHeight) {
      editor.scrollTop = bottom - editor.clientHeight;
    }
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderHighlightOverlay(matches = [], activeIndex = -1) {
    const overlay = getHighlightOverlay();
    const editor = getEditor();
    if (!overlay || !editor) return;
    if (!matches.length) {
      overlay.innerHTML = '';
      overlay.classList.add('hidden');
      return;
    }
    const text = editor.value || '';
    let html = '';
    let cursor = 0;
    matches.forEach((match, index) => {
      html += escapeHtml(text.slice(cursor, match.start));
      const current = escapeHtml(text.slice(match.start, match.end)) || '&nbsp;';
      const className = index === activeIndex ? ' class="current"' : '';
      html += `<mark${className}>${current}</mark>`;
      cursor = match.end;
    });
    html += escapeHtml(text.slice(cursor));
    overlay.innerHTML = html;
    overlay.scrollTop = editor.scrollTop;
    overlay.scrollLeft = editor.scrollLeft;
    overlay.classList.remove('hidden');
  }

  function selectMatch(index, options = {}) {
    const { focusInput = false, preserveFocus = false } = options;
    const editor = getEditor();
    const { matches } = state.findReplace;
    if (!matches.length || index < 0 || index >= matches.length) {
      state.findReplace.activeIndex = -1;
      renderHighlightOverlay([], -1);
      if (focusInput) {
        $('#find-input').focus();
        $('#find-input').select();
      } else if (!preserveFocus) {
        editor.focus();
      }
      updateStatus();
      return;
    }
    const match = matches[index];
    state.findReplace.activeIndex = index;
    renderHighlightOverlay(matches, index);
    revealSelection(editor, match.start);
    if (focusInput) {
      $('#find-input').focus();
      $('#find-input').select();
    } else if (!preserveFocus) {
      editor.focus();
    }
    updateStatus();
  }

  function refreshMatches(selectionStart = getEditor().selectionStart, direction = 'forward') {
    const editor = getEditor();
    state.findReplace.query = $('#find-input').value;
    state.findReplace.replacement = $('#replace-input').value;
    state.findReplace.matches = findMatches(editor.value, state.findReplace.query);
    state.findReplace.activeIndex = getActiveMatchIndex(state.findReplace.matches, selectionStart, direction);
    updateStatus();
  }

  function updateStatus() {
    const { matches, activeIndex } = state.findReplace;
    const count = matches.length;
    const readOnly = getEditor().readOnly;
    $('#find-match-count').textContent = count
      ? `${activeIndex + 1} / ${count}`
      : '0 / 0';
    $('#btn-find-prev').disabled = count === 0;
    $('#btn-find-next').disabled = count === 0;
    $('#btn-replace-one').disabled = count === 0 || readOnly;
    $('#btn-replace-all').disabled = count === 0 || readOnly;
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
    refreshMatches(getEditor().selectionStart, 'forward');
    selectMatch(state.findReplace.activeIndex, { focusInput: true });
    return true;
  }

  function closeToolbar() {
    $('#find-replace-bar').classList.add('hidden');
    state.findReplace.open = false;
    state.findReplace.activeIndex = -1;
    renderHighlightOverlay([], -1);
    getEditor().focus();
  }

  function jump(direction) {
    const { matches } = state.findReplace;
    if (!matches.length) return;
    const currentIndex = state.findReplace.activeIndex < 0 ? 0 : state.findReplace.activeIndex;
    const delta = direction === 'backward' ? -1 : 1;
    const nextIndex = (currentIndex + delta + matches.length) % matches.length;
    selectMatch(nextIndex, { preserveFocus: true });
  }

  function markEditorChanged() {
    App.helpers.markEditorChanged();
  }

  function replaceCurrent() {
    const editor = getEditor();
    if (editor.readOnly) return;
    const { matches, activeIndex } = state.findReplace;
    if (!matches.length || activeIndex < 0) return;
    const replacement = $('#replace-input').value;
    const match = matches[activeIndex];
    editor.value = replaceMatch(editor.value, match, replacement);
    markEditorChanged();
    const nextSelection = match.start + replacement.length;
    refreshMatches(nextSelection, 'forward');
    selectMatch(state.findReplace.activeIndex, { preserveFocus: true });
  }

  function replaceAll() {
    const editor = getEditor();
    if (editor.readOnly) return;
    const query = $('#find-input').value;
    const replacement = $('#replace-input').value;
    const result = replaceAllMatches(editor.value, query, replacement);
    if (!result.count) return;
    editor.value = result.text;
    markEditorChanged();
    refreshMatches(0, 'forward');
    selectMatch(state.findReplace.activeIndex, { preserveFocus: true });
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

  function syncToEditorSelection() {
    if (!state.findReplace.open) return;
    refreshMatches(getEditor().selectionStart, 'forward');
    updateStatus();
  }

  function syncHighlightScroll() {
    const overlay = getHighlightOverlay();
    const editor = getEditor();
    if (!overlay || !editor || overlay.classList.contains('hidden')) return;
    overlay.scrollTop = editor.scrollTop;
    overlay.scrollLeft = editor.scrollLeft;
  }

  function bindEvents() {
    $('#find-input').addEventListener('input', () => {
      refreshMatches(getEditor().selectionStart, 'forward');
      selectMatch(state.findReplace.activeIndex, { preserveFocus: true });
    });
    $('#replace-input').addEventListener('input', () => {
      state.findReplace.replacement = $('#replace-input').value;
    });
    $('#btn-find-prev').addEventListener('click', () => jump('backward'));
    $('#btn-find-next').addEventListener('click', () => jump('forward'));
    $('#btn-replace-one').addEventListener('click', replaceCurrent);
    $('#btn-replace-all').addEventListener('click', replaceAll);
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
    getEditor().addEventListener('click', syncToEditorSelection);
    getEditor().addEventListener('keyup', syncToEditorSelection);
    getEditor().addEventListener('scroll', syncHighlightScroll);
  }

  App.findReplace = {
    bindEvents,
    closeToolbar,
    handleGlobalShortcut,
    openToolbar,
    refreshMatches,
    selectMatch
  };
})(typeof window !== 'undefined' ? window : globalThis);
