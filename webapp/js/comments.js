(function (root) {
  function getTimestamp(value) {
    const timestamp = Date.parse(value || '');
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  function getThreadLatestActivityTimestamp(thread) {
    const timestamps = [getTimestamp(thread && thread.createdAt)];
    for (const comment of (thread && thread.comments) || []) {
      timestamps.push(getTimestamp(comment.createdAt));
    }
    return Math.max(...timestamps);
  }

  function getThreadStartLine(thread) {
    const startLine = thread && thread.anchor ? Number(thread.anchor.startLine) : Number.NaN;
    return Number.isFinite(startLine) ? startLine : Number.POSITIVE_INFINITY;
  }

  function isGlobalThread(thread) {
    return !thread || !thread.anchor || !Number.isFinite(Number(thread.anchor.startLine));
  }

  function compareValues(left, right) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  function compareThreadsByActivityDesc(left, right) {
    return compareValues(getThreadLatestActivityTimestamp(right), getThreadLatestActivityTimestamp(left))
      || compareValues(getThreadStartLine(left), getThreadStartLine(right))
      || compareValues(getTimestamp(left && left.createdAt), getTimestamp(right && right.createdAt))
      || compareValues((left && left.id) || '', (right && right.id) || '');
  }

  function compareThreadsByActivityAsc(left, right) {
    return compareValues(getThreadLatestActivityTimestamp(left), getThreadLatestActivityTimestamp(right))
      || compareValues(getThreadStartLine(left), getThreadStartLine(right))
      || compareValues(getTimestamp(left && left.createdAt), getTimestamp(right && right.createdAt))
      || compareValues((left && left.id) || '', (right && right.id) || '');
  }

  function compareThreadsByLineAsc(left, right) {
    return compareValues(isGlobalThread(left) ? 0 : 1, isGlobalThread(right) ? 0 : 1)
      || compareValues(getThreadStartLine(left), getThreadStartLine(right))
      || compareThreadsByActivityDesc(left, right)
      || compareValues((left && left.id) || '', (right && right.id) || '');
  }

  function sortThreads(threads, sortMode = 'activity-desc') {
    const list = Array.isArray(threads) ? [...threads] : [];
    const comparator = sortMode === 'activity-asc'
      ? compareThreadsByActivityAsc
      : sortMode === 'line-asc'
        ? compareThreadsByLineAsc
        : compareThreadsByActivityDesc;
    return list.sort(comparator);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      getThreadLatestActivityTimestamp,
      isGlobalThread,
      getThreadStartLine,
      sortThreads
    };
    return;
  }

  const App = root.App;
  const state = App.state;
  const $ = App.$;
  const {
    openSidePanel,
    canCommentCurrentProject,
    canEditCurrentProject,
    currentCommentContext,
    esc,
    formatDate
  } = App.helpers;

  const ANCHORED_DRAFT_STORAGE_PREFIX = 'md-review:anchored-comment-draft:';

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

  function getDraftStorageKey(context) {
    if (!context) return '';
    return `${ANCHORED_DRAFT_STORAGE_PREFIX}${context.projectId}:${context.filePath}:${context.commitSha}`;
  }

  function normalizeAnchor(anchor) {
    if (!anchor || !anchor.startLine || !anchor.endLine) return null;
    return {
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      startOffset: typeof anchor.startOffset === 'number' ? anchor.startOffset : null,
      endOffset: typeof anchor.endOffset === 'number' ? anchor.endOffset : null,
      selectedText: anchor.selectedText || ''
    };
  }

  function anchorsEqual(left, right) {
    if (!left || !right) return false;
    return left.startLine === right.startLine
      && left.endLine === right.endLine
      && left.startOffset === right.startOffset
      && left.endOffset === right.endOffset
      && (left.selectedText || '') === (right.selectedText || '');
  }

  function loadAnchoredDraft(context = currentCommentContext()) {
    const key = getDraftStorageKey(context);
    if (!key) return null;
    try {
      const raw = root.localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.body !== 'string') return null;
      const anchor = normalizeAnchor(parsed.anchor);
      if (!anchor) return null;
      return {
        body: parsed.body,
        anchor,
        updatedAt: parsed.updatedAt || null
      };
    } catch {
      return null;
    }
  }

  function saveAnchoredDraft(draft, context = currentCommentContext()) {
    const key = getDraftStorageKey(context);
    if (!key || !draft || !draft.anchor) return;
    root.localStorage.setItem(key, JSON.stringify({
      body: draft.body || '',
      anchor: normalizeAnchor(draft.anchor),
      updatedAt: new Date().toISOString()
    }));
  }

  function clearAnchoredDraft(context = currentCommentContext()) {
    const key = getDraftStorageKey(context);
    if (!key) return;
    root.localStorage.removeItem(key);
  }

  function getAnchoredDraftElements() {
    return {
      composer: $('#anchored-thread-composer'),
      anchor: $('#anchored-thread-anchor'),
      body: $('#anchored-thread-body'),
      post: $('#btn-post-anchored-thread'),
      discard: $('#btn-discard-anchored-thread')
    };
  }

  function closeAnchoredComposer() {
    state.pendingAnchoredComment = null;
    const elements = getAnchoredDraftElements();
    elements.composer.classList.add('hidden');
    elements.anchor.innerHTML = '';
    elements.body.value = '';
  }

  function renderAnchoredComposer() {
    const elements = getAnchoredDraftElements();
    const canComment = canCommentCurrentProject();
    const pending = state.pendingAnchoredComment;
    if (!pending || !pending.anchor) {
      closeAnchoredComposer();
      return;
    }
    elements.composer.classList.remove('hidden');
    elements.anchor.innerHTML = getAnchorLabel(pending.anchor);
    if (elements.body.value !== (pending.body || '')) {
      elements.body.value = pending.body || '';
    }
    elements.body.disabled = !canComment;
    elements.post.disabled = !canComment || !elements.body.value.trim();
    elements.discard.disabled = false;
  }

  function syncAnchoredDraftFromStorage() {
    state.pendingAnchoredComment = loadAnchoredDraft();
    renderAnchoredComposer();
  }

  function updateCommentMarkers() {
    const preview = $('#preview');
    preview.querySelectorAll('.comment-indicator').forEach((marker) => marker.remove());
    for (const thread of state.threads) {
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

  async function loadThreads() {
    const context = currentCommentContext();
    syncAnchoredDraftFromStorage();
    if (!context) {
      state.threads = [];
      renderThreads();
      return;
    }
    const query = new URLSearchParams({
      commitSha: context.commitSha,
      filePath: context.filePath
    });
    state.threads = await App.api('GET', `/projects/${state.currentProject.id}/threads?${query.toString()}`);
    renderThreads();
  }

  function renderThreads() {
    const list = $('#thread-list');
    const visibleThreads = sortThreads(
      state.threads.filter((thread) => state.showResolved || !thread.resolved),
      state.commentSort
    );
    const canComment = canCommentCurrentProject();
    const canResolve = canEditCurrentProject();
    $('#thread-body').disabled = !canComment;
    $('#btn-add-thread').disabled = !canComment;
    $('#thread-body').placeholder = canComment ? 'New comment...' : 'File access required to comment';
    renderAnchoredComposer();
    $('#comment-sort').value = state.commentSort;
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
          await App.api('POST', '/comment-lines', { ...context, threadId: thread.id, body: replyInput.value.trim() });
          await loadThreads();
        } catch (error) {
          alert(error.message);
        }
      });
      replySection.appendChild(replyInput);
      replySection.appendChild(replyBtn);
      div.appendChild(replySection);

      div.addEventListener('click', (event) => {
        if (event.target.closest('.btn-resolve') || event.target.closest('.btn-delete-thread') || event.target.tagName === 'INPUT' || event.target.tagName === 'BUTTON' || event.target.tagName === 'TEXTAREA') return;
        openThreadInPanel(thread.id);
      });

      div.querySelector('.btn-resolve').addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!canResolve) return;
        try {
          const context = currentCommentContext();
          if (!context) throw new Error('Missing comment context for current file version');
          await App.api('POST', `/comments/threads/${thread.id}/resolve`, context);
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
            await App.api('DELETE', `/comments/threads/${thread.id}`, context);
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

  function focusAnchoredComposer() {
    getAnchoredDraftElements().body.focus();
  }

  async function activateAnchoredDraft(anchor, options = {}) {
    const context = currentCommentContext();
    if (!context) return;
    const normalizedAnchor = normalizeAnchor(anchor);
    if (!normalizedAnchor) return;
    const existing = loadAnchoredDraft(context);
    if (existing && !anchorsEqual(existing.anchor, normalizedAnchor)) {
      const shouldReplace = window.confirm('You already have an unsaved anchored comment for this file version. Discard it and start a new one?');
      if (!shouldReplace) {
        state.pendingAnchoredComment = existing;
        openSidePanel('comments');
        await loadThreads();
        if (options.focus !== false) focusAnchoredComposer();
        return;
      }
    }
    state.pendingAnchoredComment = {
      body: '',
      anchor: normalizedAnchor,
      updatedAt: new Date().toISOString()
    };
    saveAnchoredDraft(state.pendingAnchoredComment, context);
    openSidePanel('comments');
    await loadThreads();
    if (options.focus !== false) focusAnchoredComposer();
  }

  function showCommentPrompt(range, preparedAnchor) {
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
      await activateAnchoredDraft(preparedAnchor);
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
        const selectedText = selection.toString().trim();
        if (!selectedText || selectedText.length < 2) return;
        const startLine = App.preview.getSelectionLine(range.startContainer);
        const endLine = App.preview.getSelectionLine(range.endContainer);
        if (!startLine || !endLine) return;
        const offsets = App.preview.getSourceOffsetsFromPreviewSelection(startLine, endLine, selectedText);
        showCommentPrompt(range, {
          startLine,
          endLine,
          startOffset: offsets ? offsets.startOffset : null,
          endOffset: offsets ? offsets.endOffset : null,
          selectedText
        });
      }, 200);
    });
  }

  function openThreadInPanel(threadId) {
    openSidePanel('comments');
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
      const thread = state.threads.find((item) => item.id === threadId);
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
    await App.api('POST', '/comments/threads', { ...context, body });
    $('#thread-body').value = '';
    await loadThreads();
  }

  async function postAnchoredThread() {
    const context = currentCommentContext();
    const pending = state.pendingAnchoredComment;
    if (!context || !pending || !pending.anchor) return;
    const body = ($('#anchored-thread-body').value || '').trim();
    if (!body) return;
    await App.api('POST', '/comments/threads', {
      ...context,
      body,
      anchor: pending.anchor
    });
    clearAnchoredDraft(context);
    closeAnchoredComposer();
    await loadThreads();
    updateCommentMarkers();
  }

  function discardAnchoredThread() {
    clearAnchoredDraft();
    closeAnchoredComposer();
  }

  function handleAnchoredDraftInput() {
    const pending = state.pendingAnchoredComment;
    if (!pending || !pending.anchor) return;
    pending.body = $('#anchored-thread-body').value;
    saveAnchoredDraft(pending);
    getAnchoredDraftElements().post.disabled = !pending.body.trim();
  }

  function bindComposerEvents() {
    $('#anchored-thread-body').addEventListener('input', handleAnchoredDraftInput);
    $('#btn-post-anchored-thread').addEventListener('click', async () => {
      try {
        await postAnchoredThread();
      } catch (error) {
        alert(`Failed to create thread: ${error.message}`);
      }
    });
    $('#btn-discard-anchored-thread').addEventListener('click', () => {
      discardAnchoredThread();
    });
  }

  App.comments = {
    activateAnchoredDraft,
    bindComposerEvents,
    clearThreadHighlights,
    createThread,
    getAnchorLabel,
    getAnchorSelectedText,
    highlightPreviewText,
    initSelectionListener,
    loadThreads,
    openThreadInPanel,
    renderThreads,
    scrollElementIntoContainer,
    syncAnchoredDraftFromStorage,
    updateCommentMarkers
  };
})(typeof window !== 'undefined' ? window : globalThis);
