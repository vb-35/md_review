(function (root) {
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function decisionKey(rowId, chunkId) {
    return `${rowId}::${chunkId}`;
  }

  function decisionButtons(rowId, chunks, decisions, enabled) {
    const disabled = enabled ? '' : ' disabled';
    return (chunks || []).map((chunk) => {
      const decision = decisions[decisionKey(rowId, chunk.chunkId)] || '';
      return `<span class="review-inline-actions">
        <button type="button" class="diff-action accept${decision === 'accept' ? ' active' : ''}"
          data-review-action="accept" data-review-row-id="${esc(rowId)}"
          data-review-chunk-id="${esc(chunk.chunkId)}"${disabled}>Accept</button>
        <button type="button" class="diff-action refuse${decision === 'refuse' ? ' active' : ''}"
          data-review-action="refuse" data-review-row-id="${esc(rowId)}"
          data-review-chunk-id="${esc(chunk.chunkId)}"${disabled}>Refuse</button>
      </span>`;
    }).join('');
  }

  function lineGroupButton(row, decisions, enabled) {
    const chunks = row.chunks || [];
    if (chunks.length < 2) return '';
    const allAccepted = chunks.every((chunk) => decisions[decisionKey(row.rowId, chunk.chunkId)] === 'accept');
    return `<button type="button" class="diff-action accept review-accept-line${allAccepted ? ' active' : ''}"
      data-review-accept-line="${esc(row.rowId)}" aria-pressed="${allAccepted ? 'true' : 'false'}"
      ${enabled ? '' : 'disabled'}>Accept line</button>`;
  }

  function renderReplacementLine(baseRow, candidateRow, decisions, enabled) {
    const chunks = Object.fromEntries((candidateRow.chunks || []).map((chunk) => [chunk.chunkId, chunk]));
    const content = (candidateRow.segments || []).map((segment) => {
      if (!segment.changed || !segment.chunkId) return esc(segment.text);
      const chunk = chunks[segment.chunkId];
      if (!chunk) return `<ins class="review-added">${esc(segment.text)}</ins>`;
      const removed = chunk.baseText
        ? `<del class="review-removed">${esc(chunk.baseText)}</del>`
        : '';
      const added = chunk.candText
        ? `<ins class="review-added">${esc(chunk.candText)}</ins>`
        : '';
      return `${removed}${added}${decisionButtons(candidateRow.rowId, [chunk], decisions, enabled)}`;
    }).join('');
    return `<div class="review-source-line review-source-replacement" data-candidate-line="${candidateRow.candLine || ''}">
      <span class="review-source-line-number">${esc(candidateRow.candLine || baseRow.baseLine || '')}</span>
      <code>${content || '&nbsp;'}</code>
      ${lineGroupButton(candidateRow, decisions, enabled)}
    </div>`;
  }

  function renderTrackedSource(diff, decisions = {}, enabled = false, labels = {}) {
    const rows = Array.isArray(diff) ? diff : [];
    const byId = Object.fromEntries(rows.map((row) => [row.rowId, row]));
    const lines = [];
    rows.forEach((row) => {
      if (row.type === 'removed' && row.pairRowId && byId[row.pairRowId]) return;
      if (row.type === 'added' && row.pairRowId && byId[row.pairRowId]) {
        lines.push(renderReplacementLine(byId[row.pairRowId], row, decisions, enabled));
        return;
      }
      if (row.type === 'added') {
        lines.push(`<div class="review-source-line review-source-added" data-candidate-line="${row.candLine || ''}">
          <span class="review-source-line-number">${esc(row.candLine || '')}</span>
          <code><ins class="review-added">${esc(row.line) || '&nbsp;'}</ins>${decisionButtons(row.rowId, row.chunks, decisions, enabled)}</code>
          ${lineGroupButton(row, decisions, enabled)}
        </div>`);
        return;
      }
      if (row.type === 'removed') {
        lines.push(`<div class="review-source-line review-source-removed" data-base-line="${row.baseLine || ''}">
          <span class="review-source-line-number">${esc(row.baseLine || '')}</span>
          <code><del class="review-removed">${esc(row.line) || '&nbsp;'}</del>${decisionButtons(row.rowId, row.chunks, decisions, enabled)}</code>
          ${lineGroupButton(row, decisions, enabled)}
        </div>`);
        return;
      }
      lines.push(`<div class="review-source-line" data-candidate-line="${row.candLine || ''}">
        <span class="review-source-line-number">${esc(row.candLine || row.baseLine || '')}</span>
        <code>${esc(row.line) || '&nbsp;'}</code>
      </div>`);
    });
    return `<div class="review-document-header">
      <strong>${esc(labels.base || 'Base')} → ${esc(labels.candidate || 'Candidate')}</strong>
      <span><ins>Added</ins><del>Removed</del></span>
    </div>
    <div class="review-source-lines">${lines.join('')}</div>`;
  }

  function nearestCandidateLine(rows, index) {
    for (let offset = index + 1; offset < rows.length; offset += 1) {
      if (rows[offset].candLine) return rows[offset].candLine;
    }
    for (let offset = index - 1; offset >= 0; offset -= 1) {
      if (rows[offset].candLine) return rows[offset].candLine;
    }
    return null;
  }

  function buildPreviewAnnotations(diff) {
    const rows = Array.isArray(diff) ? diff : [];
    const byId = Object.fromEntries(rows.map((row) => [row.rowId, row]));
    const annotations = [];
    rows.forEach((row, index) => {
      if (row.type === 'removed' && row.pairRowId && byId[row.pairRowId]) return;
      if (row.type === 'added' && row.pairRowId && byId[row.pairRowId]) {
        (row.chunks || []).forEach((chunk) => annotations.push({
          kind: 'replace',
          row,
          rowId: row.rowId,
          chunks: [chunk],
          candidateLine: row.candLine || null,
          removedText: chunk.baseText || '',
          addedText: chunk.candText || '',
        }));
        return;
      }
      if (row.type === 'added') {
        annotations.push({
          kind: 'add',
          row,
          rowId: row.rowId,
          chunks: row.chunks || [],
          candidateLine: row.candLine || null,
          removedText: '',
          addedText: row.line || '',
        });
        return;
      }
      if (row.type === 'removed') {
        annotations.push({
          kind: 'remove',
          row,
          rowId: row.rowId,
          chunks: row.chunks || [],
          candidateLine: nearestCandidateLine(rows, index),
          removedText: row.line || '',
          addedText: '',
        });
      }
    });
    return annotations;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildPreviewAnnotations, decisionKey, renderTrackedSource };
    return;
  }

  const App = root.App;
  const state = App.state;
  const $ = App.$;
  let bound = false;

  function isVisible() {
    return !!(state.mainReview && state.mainReview.visible);
  }

  function updateToggle() {
    const button = $('#btn-main-review-toggle');
    if (!button) return;
    const active = isVisible();
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.textContent = active ? 'Hide document changes' : 'Changes in document';
  }

  function candidateVersionPath() {
    const comparison = state.comparedDiff;
    if (!comparison || !state.currentProject || !state.currentFile) return '';
    return `/projects/${state.currentProject.id}/files/versions/${encodeURIComponent(comparison.versionBId)}?path=${encodeURIComponent(state.currentFile.filePath)}`;
  }

  function canDecide() {
    return !!(App.projects && App.projects.canApplyDiffChunks && App.projects.canApplyDiffChunks());
  }

  function labels() {
    const comparison = state.comparedDiff || {};
    return {
      base: comparison.labelA || 'Base',
      candidate: comparison.labelB || 'Candidate',
    };
  }

  function renderSource() {
    if (!isVisible()) return;
    const source = $('#review-source');
    const previousRange = Math.max(0, source.scrollHeight - source.clientHeight);
    const ratio = previousRange > 0 ? source.scrollTop / previousRange : 0;
    source.innerHTML = renderTrackedSource(
      state.comparedDiff ? state.comparedDiff.diff : [],
      state.comparedDiffDecisions || {},
      canDecide(),
      labels()
    );
    const nextRange = Math.max(0, source.scrollHeight - source.clientHeight);
    source.scrollTop = ratio * nextRange;
  }

  function lineTarget(preview, lineNumber) {
    if (!Number.isFinite(Number(lineNumber))) return null;
    const targets = [...preview.querySelectorAll(`[data-line="${Number(lineNumber)}"]`)];
    return targets.find((target) => !target.closest('.review-preview-callout')) || null;
  }

  function reviewTextNodes(target) {
    const nodes = [];
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('.review-inline-actions, .review-preview-callout, ins.review-added, del.review-removed')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  function wrapFirstText(target, text, tagName, className) {
    const needle = String(text || '');
    if (!target || !needle) return null;
    for (const node of reviewTextNodes(target)) {
      const index = node.textContent.indexOf(needle);
      if (index === -1) continue;
      const before = node;
      const match = index > 0 ? before.splitText(index) : before;
      const after = match.splitText(needle.length);
      const wrapper = document.createElement(tagName);
      wrapper.className = className;
      wrapper.textContent = match.textContent;
      match.parentNode.replaceChild(wrapper, match);
      void after;
      return wrapper;
    }
    return null;
  }

  function controlsFor(rowId, chunks) {
    const holder = document.createElement('span');
    holder.className = 'review-preview-controls';
    holder.innerHTML = decisionButtons(
      rowId,
      chunks,
      state.comparedDiffDecisions || {},
      canDecide()
    );
    return holder;
  }

  function groupControlFor(row) {
    const holder = document.createElement('span');
    holder.className = 'review-preview-controls';
    holder.innerHTML = lineGroupButton(
      row,
      state.comparedDiffDecisions || {},
      canDecide()
    );
    return holder;
  }

  function fallbackCallout(target, rowId, chunks, removedText, addedText, placement = 'after') {
    const callout = document.createElement('span');
    callout.className = 'review-preview-callout';
    if (removedText) {
      const removed = document.createElement('del');
      removed.className = 'review-removed';
      removed.textContent = removedText;
      callout.appendChild(removed);
    }
    if (addedText) {
      const added = document.createElement('ins');
      added.className = 'review-added';
      added.textContent = addedText;
      callout.appendChild(added);
    }
    callout.appendChild(controlsFor(rowId, chunks));
    if (!target) {
      $('#preview').appendChild(callout);
    } else if (placement === 'before') {
      target.parentNode.insertBefore(callout, target);
    } else {
      target.appendChild(callout);
    }
  }

  function decoratePreview(preview) {
    if (!isVisible() || !state.comparedDiff) return;
    const annotations = buildPreviewAnnotations(state.comparedDiff.diff || []);
    const groupedRows = new Set();
    annotations.forEach((annotation) => {
      const target = lineTarget(preview, annotation.candidateLine);
      if (annotation.kind === 'replace') {
        annotation.chunks.forEach((chunk) => {
          const inserted = wrapFirstText(target, annotation.addedText, 'ins', 'review-added');
          if (!inserted) {
            fallbackCallout(target, annotation.rowId, [chunk], annotation.removedText, annotation.addedText);
            return;
          }
          if (annotation.removedText) {
            const removed = document.createElement('del');
            removed.className = 'review-removed';
            removed.textContent = annotation.removedText;
            inserted.parentNode.insertBefore(removed, inserted);
          }
          inserted.parentNode.insertBefore(controlsFor(annotation.rowId, [chunk]), inserted.nextSibling);
        });
        if (
          target &&
          (annotation.row.chunks || []).length > 1 &&
          !groupedRows.has(annotation.rowId)
        ) {
          target.appendChild(groupControlFor(annotation.row));
          groupedRows.add(annotation.rowId);
        }
        return;
      }
      if (annotation.kind === 'add') {
        const inserted = wrapFirstText(target, annotation.addedText, 'ins', 'review-added');
        if (inserted) {
          inserted.parentNode.insertBefore(controlsFor(annotation.rowId, annotation.chunks), inserted.nextSibling);
          if (annotation.chunks.length > 1) inserted.parentNode.insertBefore(groupControlFor(annotation.row), inserted.nextSibling);
        } else {
          fallbackCallout(target, annotation.rowId, annotation.chunks, '', annotation.addedText);
        }
        return;
      }
      if (annotation.kind === 'remove') {
        fallbackCallout(target, annotation.rowId, annotation.chunks, annotation.removedText, '', 'before');
      }
    });
  }

  function renderPreview() {
    if (!isVisible() || !App.preview || !App.preview.renderSource) return;
    const preview = $('#preview');
    const range = Math.max(0, preview.scrollHeight - preview.clientHeight);
    const ratio = range > 0 ? preview.scrollTop / range : 0;
    App.preview.renderSource(state.mainReview.candidateContent, { reviewMode: true });
    const nextRange = Math.max(0, preview.scrollHeight - preview.clientHeight);
    preview.scrollTop = ratio * nextRange;
  }

  function refresh() {
    if (!isVisible()) return;
    renderSource();
    renderPreview();
  }

  async function show() {
    if (!state.comparedDiff || !state.currentFile) return;
    const commentPrompt = document.querySelector('.selection-comment-prompt');
    if (commentPrompt) commentPrompt.remove();
    const button = $('#btn-main-review-toggle');
    button.disabled = true;
    button.textContent = 'Loading changes…';
    try {
      const candidate = await App.api('GET', candidateVersionPath());
      state.mainReview = {
        visible: true,
        candidateContent: candidate.content || '',
        versionBId: state.comparedDiff.versionBId,
        filePath: state.currentFile.filePath,
      };
      $('#editor-root').classList.add('hidden');
      $('#review-source').classList.remove('hidden');
      refresh();
      $('#review-source').focus({ preventScroll: true });
    } catch (error) {
      state.mainReview = null;
      window.alert(`Could not show document changes: ${error.message}`);
    } finally {
      button.disabled = false;
      updateToggle();
    }
  }

  function hide() {
    if (!isVisible()) {
      updateToggle();
      return;
    }
    state.mainReview = null;
    $('#review-source').classList.add('hidden');
    $('#editor-root').classList.remove('hidden');
    updateToggle();
    if (App.preview && App.preview.updatePreview) App.preview.updatePreview();
    if (App.editor && App.editor.focus) App.editor.focus();
  }

  function clear() {
    hide();
    const source = $('#review-source');
    if (source) source.innerHTML = '';
  }

  async function toggle() {
    if (isVisible()) {
      hide();
      return;
    }
    await show();
  }

  function handleAction(event) {
    const button = event.target.closest('[data-review-action], [data-review-accept-line]');
    if (!button || button.disabled) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (button.dataset.reviewAcceptLine) {
      App.projects.acceptAllDiffChunks(button.dataset.reviewAcceptLine);
    } else {
      App.projects.applyDiffDecision(
        button.dataset.reviewRowId,
        button.dataset.reviewChunkId,
        button.dataset.reviewAction
      );
    }
    return true;
  }

  function syncSourceToPreview() {
    if (!isVisible() || !state.settings.syncView || state.syncingScroll) return;
    const source = $('#review-source');
    const preview = $('#preview');
    if (!source.offsetParent || !preview.offsetParent) return;
    const sourceRange = source.scrollHeight - source.clientHeight;
    const previewRange = preview.scrollHeight - preview.clientHeight;
    state.syncingScroll = true;
    preview.scrollTop = (sourceRange > 0 ? source.scrollTop / sourceRange : 0) * Math.max(0, previewRange);
    requestAnimationFrame(() => { state.syncingScroll = false; });
  }

  function syncPreviewToSource() {
    if (!isVisible() || !state.settings.syncView || state.syncingScroll) return false;
    const source = $('#review-source');
    const preview = $('#preview');
    if (!source.offsetParent || !preview.offsetParent) return true;
    const sourceRange = source.scrollHeight - source.clientHeight;
    const previewRange = preview.scrollHeight - preview.clientHeight;
    state.syncingScroll = true;
    source.scrollTop = (previewRange > 0 ? preview.scrollTop / previewRange : 0) * Math.max(0, sourceRange);
    requestAnimationFrame(() => { state.syncingScroll = false; });
    return true;
  }

  function bindEvents() {
    if (bound) return;
    bound = true;
    $('#btn-main-review-toggle').addEventListener('click', toggle);
    $('#review-source').addEventListener('click', handleAction);
    $('#review-source').addEventListener('scroll', syncSourceToPreview);
    $('#preview').addEventListener('click', (event) => {
      if (isVisible()) handleAction(event);
    }, true);
  }

  App.reviewMain = {
    bindEvents,
    clear,
    decoratePreview,
    hide,
    isVisible,
    refresh,
    renderPreview,
    renderSource,
    show,
    syncPreviewToSource,
    toggle,
  };
})(typeof window !== 'undefined' ? window : globalThis);
