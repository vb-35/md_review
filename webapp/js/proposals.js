(function (root) {
  const App = root.App;
  const state = App.state;
  const $ = App.$;
  const { capitalize, esc, formatDate, holdsCurrentLock } = App.helpers;

  function statusLabel(status) {
    return capitalize(status || 'pending');
  }

  function canReview(proposal) {
    return !!state.currentUser
      && !!state.currentProject
      && ['owner', 'admin', 'editor'].includes(state.currentProject.accessRole)
      && proposal.status === 'pending'
      && holdsCurrentLock();
  }

  function canDeleteProposal(proposal) {
    return !!state.currentUser
      && !!state.currentProject
      && proposal.status !== 'accepted'
      && (state.currentUser.id === proposal.authorId || state.currentProject.accessRole === 'owner');
  }

  async function loadProposals(render = true) {
    if (!state.currentProject) {
      state.proposals = [];
      state.currentProposal = null;
      if (render) renderProposalList();
      return [];
    }
    state.proposals = await App.api('GET', `/projects/${state.currentProject.id}/proposals`);
    if (state.currentProposal) {
      const current = state.proposals.find((item) => item.id === state.currentProposal.id);
      state.currentProposal = current
        ? await App.api('GET', `/projects/${state.currentProject.id}/proposals/${current.id}`)
        : null;
    }
    if (render) renderProposalList();
    return state.proposals;
  }

  function renderProposalList() {
    const list = $('#proposal-list');
    const review = $('#proposal-review');
    if (!list || !review) return;
    placeReview();
    review.classList.toggle('hidden', !state.currentProposal);
    if (state.currentProposal) {
      renderProposalDetail();
      return;
    }
    if (!state.proposals.length) {
      list.innerHTML = '<div class="proposal-empty">No revision proposals yet.</div>';
      list.classList.remove('hidden');
      return;
    }
    list.classList.remove('hidden');
    list.innerHTML = state.proposals.map((proposal) => `
      <button type="button" class="proposal-row" data-proposal-id="${proposal.id}">
        <span class="proposal-row-main">
          <strong>${esc(proposal.title)}</strong>
          <span>by ${esc(proposal.authorUsername)} · ${esc(formatDate(proposal.createdAt))}</span>
        </span>
        <span class="proposal-status ${esc(proposal.status)}">${esc(statusLabel(proposal.status))}</span>
      </button>
    `).join('');
    list.querySelectorAll('[data-proposal-id]').forEach((button) => {
      button.addEventListener('click', () => openProposal(button.dataset.proposalId));
    });
  }

  async function openProposal(proposalId) {
    if (!App.helpers.confirmLeaveEditor()) return;
    state.currentProposal = await App.api(
      'GET',
      `/projects/${state.currentProject.id}/proposals/${proposalId}`
    );
    const firstPath = state.currentProposal.files[0]?.filePath || state.currentProposal.commentActions[0]?.filePath;
    if (firstPath) {
      await openProposalFile(firstPath);
      return;
    }
    renderProposalList();
  }

  // ponytail: move the existing review controls between hosts; one set of decisions and handlers.
  function placeReview() {
    const inEditor = state.currentView === 'editor' && !!state.currentProposal;
    $(inEditor ? '#editor-proposal-host' : '#dashboard-proposal-host').appendChild($('#proposal-review'));
    $('#version-browser').classList.toggle('hidden', inEditor);
    $('#review-panel-title').textContent = inEditor ? 'Proposal review' : 'Version History';
  }

  async function openProposalFile(filePath) {
    try {
      if (!await App.projects.openMarkdownFile(filePath)) return;
      App.helpers.openSidePanel('review');
      renderProposalDetail();
      if (App.helpers.hasUnsavedChanges()) {
        App.helpers.setSaveStatus('Draft recovered · save manual edits before reviewing');
        return;
      }
      await App.projects.loadVersions();
      const version = state.versions.find((item) => item.proposalId === state.currentProposal.id);
      if (!version) return;
      state.selectedHeadId = version.id;
      $('#version-select-head').value = version.id;
      App.projects.syncProposalBase(version.id);
      await App.projects.compareSelectedVersions();
      await App.reviewMain.show();
    } catch (error) {
      App.helpers.setSaveStatus(`Could not open proposal file: ${error.message}`);
      renderProposalDetail();
    }
  }

  function closeProposal() {
    if (!App.helpers.confirmLeaveEditor()) return;
    state.currentProposal = null;
    App.helpers.resetEditorState();
    App.helpers.showDashboard();
    $('#proposal-review').classList.add('hidden');
    $('#proposal-list').classList.remove('hidden');
    renderProposalList();
  }

  function renderDecisionButtons(kind, filePath, itemId, decision, enabled) {
    const disabled = enabled ? '' : ' disabled';
    const encodedPath = esc(filePath || '');
    return `<span class="diff-chunk-actions proposal-decision-actions">
      <button type="button" class="diff-action accept${decision === 'accept' ? ' active' : ''}"
        data-proposal-decision="accept" data-kind="${kind}" data-file-path="${encodedPath}"
        data-item-id="${esc(itemId)}"${disabled}>Accept</button>
      <button type="button" class="diff-action refuse${decision === 'refuse' ? ' active' : ''}"
        data-proposal-decision="refuse" data-kind="${kind}" data-file-path="${encodedPath}"
        data-item-id="${esc(itemId)}"${disabled}>Refuse</button>
    </span>`;
  }

  function chunkIsActionable(row, chunk) {
    return chunk && (
      chunk.kind === 'line-add'
      || chunk.kind === 'line-remove'
      || (chunk.kind === 'replace' && row.type === 'added')
    );
  }

  function renderChunkActions(row, chunk, filePath, enabled) {
    if (!chunkIsActionable(row, chunk)) return '';
    return renderDecisionButtons('diff', filePath, chunk.itemId, chunk.decision, enabled);
  }

  function renderRowText(row, filePath, enabled) {
    const chunks = Object.fromEntries((row.chunks || []).map((chunk) => [chunk.chunkId, chunk]));
    const segments = row.segments || [{ text: row.line || '', changed: false }];
    return segments.map((segment) => {
      if (!segment.changed || !segment.chunkId) return esc(segment.text);
      const chunk = chunks[segment.chunkId];
      const controls = chunk && chunk.kind === 'replace' && row.type === 'added'
        ? renderChunkActions(row, chunk, filePath, enabled)
        : '';
      return `<span class="diff-token-changed">${esc(segment.text)}${controls}</span>`;
    }).join('');
  }

  function renderLineActions(row, filePath, enabled) {
    if (!row.chunks || row.chunks.length !== 1) return '';
    const chunk = row.chunks[0];
    if (chunk.kind !== 'line-add' && chunk.kind !== 'line-remove') return '';
    return renderChunkActions(row, chunk, filePath, enabled);
  }

  function renderFileDiff(file, enabled) {
    const lines = file.diff.map((row) => {
      const prefix = row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' ';
      const lineMeta = [row.baseLine ? `B${row.baseLine}` : '', row.candLine ? `H${row.candLine}` : '']
        .filter(Boolean).join(' ');
      return `<div class="diff-line ${row.type}" data-prefix="${prefix}">
        <span class="diff-line-body">${renderRowText(row, file.filePath, enabled)}</span>
        ${renderLineActions(row, file.filePath, enabled)}
        ${lineMeta ? `<span class="diff-line-meta">${esc(lineMeta)}</span>` : ''}
      </div>`;
    }).join('');
    const stateLabel = file.applied
      ? 'Already saved as a version'
      : file.needsSave
        ? file.decisionComplete ? 'Ready to apply on close' : 'Decisions incomplete'
        : 'Decisions incomplete';
    return `<section class="proposal-file">
      <h4>${esc(file.filePath)} <span class="proposal-file-state">${esc(stateLabel)}</span></h4>
      <div class="proposal-diff">${lines || '<div class="proposal-empty">No reviewable changes.</div>'}</div>
    </section>`;
  }

  function renderCommentAction(action, enabled) {
    const description = action.actionType === 'reply'
      ? `<p>${esc(action.body)}</p>`
      : '<p>Mark this thread as resolved.</p>';
    return `<article class="proposal-comment-action">
      <div>
        <strong>${esc(capitalize(action.actionType))} comment thread</strong>
        <span><button type="button" data-proposal-file="${encodeURIComponent(action.filePath)}">${esc(action.filePath)}</button> · ${esc(action.threadId)}</span>
        ${description}
      </div>
      ${renderDecisionButtons('comment', '', action.id, action.decision, enabled)}
    </article>`;
  }

  function allReviewItems(proposal, decision) {
    const diffItems = proposal.files.flatMap((file) => file.reviewItems.map((item) => ({
      kind: 'diff',
      filePath: file.filePath,
      itemId: item.itemId,
      decision,
    })));
    const commentItems = proposal.commentActions.map((item) => ({
      kind: 'comment',
      itemId: item.id,
      decision,
    }));
    return [...diffItems, ...commentItems];
  }

  function renderProposalDetail() {
    const proposal = state.currentProposal;
    const list = $('#proposal-list');
    const review = $('#proposal-review');
    if (!proposal || !review) return;
    placeReview();
    const inEditor = state.currentView === 'editor';
    list.classList.add('hidden');
    review.classList.remove('hidden');
    const reviewerEnabled = canReview(proposal);
    const deleteEnabled = canDeleteProposal(proposal);
    const staleNotice = proposal.staleReason
      ? `<div class="proposal-notice danger">${esc(proposal.staleReason)} Ask Codex to regenerate from the current project.</div>`
      : '';
    const progress = `${proposal.review.required - proposal.review.decided} decisions remaining · ${proposal.review.decided} of ${proposal.review.required} decided`;
    const lockNotice = proposal.status === 'pending' && !holdsCurrentLock()
      ? '<div class="proposal-notice">Take the project lock to change decisions or close this review.</div>'
      : '';
    review.innerHTML = `
      <div class="proposal-review-header">
        <button type="button" id="btn-close-proposal">Back to proposals</button>
        <span class="proposal-status ${esc(proposal.status)}">${esc(statusLabel(proposal.status))}</span>
      </div>
      <div class="proposal-title-row">
        <div>
          <h3>${esc(proposal.title)}</h3>
          <p>${esc(proposal.summary || 'No summary provided.')}</p>
          <span>Proposed by ${esc(proposal.authorUsername)} · base ${esc(proposal.baseCommitSha.slice(0, 10))}</span>
        </div>
        <strong role="status">${esc(progress)}</strong>
      </div>
      ${staleNotice}
      ${lockNotice}
      ${reviewerEnabled || deleteEnabled ? `<div class="proposal-actions">
        ${reviewerEnabled ? '<button type="button" data-bulk-decision="accept">Accept all</button>' : ''}
        ${reviewerEnabled ? '<button type="button" data-bulk-decision="refuse">Refuse all</button>' : ''}
        ${reviewerEnabled ? '<button type="button" id="btn-reject-proposal" class="danger">Reject proposal</button>' : ''}
        ${deleteEnabled ? '<button type="button" id="btn-delete-proposal" class="danger">Delete proposal</button>' : ''}
        ${reviewerEnabled ? `<button type="button" id="btn-close-proposal-review" class="primary"${proposal.review.canClose ? '' : ' disabled'}>Apply & close review</button>` : ''}
      </div>` : ''}
      <div class="proposal-files">
        ${proposal.files.map((file) => inEditor ? `
          <button type="button" class="proposal-row" data-proposal-file="${encodeURIComponent(file.filePath)}"
            aria-current="${state.currentFile?.filePath === file.filePath ? 'true' : 'false'}">
            <span>${esc(file.filePath)}</span>
            <span>${file.reviewItems.filter((item) => !item.decision).length} remaining</span>
          </button>` : renderFileDiff(file, reviewerEnabled)).join('')}
      </div>
      ${proposal.commentActions.length ? `<section class="proposal-comments">
        <h4>Comment actions</h4>
        ${proposal.commentActions.map((action) => renderCommentAction(action, reviewerEnabled)).join('')}
      </section>` : ''}
      ${proposal.status === 'closed'
        ? `<div class="proposal-notice success">Review closed by ${esc(proposal.reviewerUsername || 'reviewer')}. Saved file versions remain in project history.</div>`
        : proposal.status === 'accepted' && proposal.appliedCommitSha
          ? `<div class="proposal-notice success">Published as commit ${esc(proposal.appliedCommitSha.slice(0, 10))} by ${esc(proposal.reviewerUsername || 'reviewer')}.</div>`
          : ''}
    `;
    bindProposalDetailEvents();
  }

  function bindProposalDetailEvents() {
    $('#btn-close-proposal').addEventListener('click', closeProposal);
    $('#proposal-review').querySelectorAll('[data-proposal-file]').forEach((button) => {
      button.addEventListener('click', () => openProposalFile(decodeURIComponent(button.dataset.proposalFile)));
    });
    $('#proposal-review').querySelectorAll('[data-proposal-decision]').forEach((button) => {
      button.addEventListener('click', async () => {
        await saveDecisions([{
          kind: button.dataset.kind,
          filePath: button.dataset.filePath,
          itemId: button.dataset.itemId,
          decision: button.dataset.proposalDecision,
        }]);
      });
    });
    $('#proposal-review').querySelectorAll('[data-bulk-decision]').forEach((button) => {
      button.addEventListener('click', () => saveDecisions(allReviewItems(
        state.currentProposal,
        button.dataset.bulkDecision
      )));
    });
    const close = $('#btn-close-proposal-review');
    if (close) close.addEventListener('click', closeProposalReview);
    const reject = $('#btn-reject-proposal');
    if (reject) reject.addEventListener('click', rejectProposal);
    const remove = $('#btn-delete-proposal');
    if (remove) remove.addEventListener('click', deleteProposal);
  }

  async function saveDecisions(items) {
    if (!items.length) return;
    if (state.reviewBusy) return;
    if (state.saving || App.helpers.hasUnsavedChanges()) {
      App.helpers.setSaveStatus('Save your manual edits before changing review decisions');
      return;
    }
    state.reviewBusy = true;
    App.helpers.updateEditorPermissions();
    try {
      state.currentProposal = await App.api(
        'PUT',
        `/projects/${state.currentProject.id}/proposals/${state.currentProposal.id}/decisions`,
        { items }
      );
      await App.projects.refreshActiveProposalReview(state.currentProposal);
      renderProposalDetail();
    } catch (error) {
      alert(error.message);
    } finally {
      state.reviewBusy = false;
      App.helpers.updateEditorPermissions();
    }
  }

  async function closeProposalReview() {
    if (state.reviewBusy) return;
    if (state.saving || App.helpers.hasUnsavedChanges()) {
      App.helpers.setSaveStatus('Save your manual edits before applying the proposal');
      return;
    }
    if (!window.confirm('Apply accepted file changes as new versions, apply accepted comment actions, and close this review?')) return;
    state.reviewBusy = true;
    App.helpers.updateEditorPermissions();
    try {
      const proposalId = state.currentProposal.id;
      const refreshFilePath = state.currentFile
        ? state.currentFile.filePath
        : null;
      state.currentProposal = await App.api(
        'POST',
        `/projects/${state.currentProject.id}/proposals/${proposalId}/close`
      );
      if (refreshFilePath) {
        state.activeProposalReview = null;
        state.editing = false;
      }
      await App.projects.refreshProjectState();
      state.reviewBusy = false;
      if (refreshFilePath) await App.projects.openMarkdownFile(refreshFilePath, false);
      await loadProposals(false);
      const closed = state.proposals.find((item) => item.id === state.currentProposal.id);
      if (closed) state.currentProposal = await App.api(
        'GET',
        `/projects/${state.currentProject.id}/proposals/${closed.id}`
      );
      renderProposalList();
    } catch (error) {
      alert(error.message);
    } finally {
      state.reviewBusy = false;
      App.helpers.updateEditorPermissions();
    }
  }

  async function deleteProposal() {
    if (!App.helpers.confirmLeaveEditor()) return;
    const proposal = state.currentProposal;
    if (!proposal || !window.confirm('Delete this proposal record permanently? Saved project files and versions will not be changed.')) return;
    try {
      await App.api(
        'DELETE',
        `/projects/${state.currentProject.id}/proposals/${proposal.id}`
      );
      state.currentProposal = null;
      if (!App.helpers.hasUnsavedChanges()) App.helpers.resetEditorState();
      App.helpers.showDashboard();
      await loadProposals();
      if (state.currentFile && state.activeSidePanel === 'review') {
        await App.projects.loadVersions();
      }
    } catch (error) {
      alert(error.message);
    }
  }

  async function rejectProposal() {
    if (!window.confirm('Reject this proposal without changing project files?')) return;
    try {
      state.currentProposal = await App.api(
        'POST',
        `/projects/${state.currentProject.id}/proposals/${state.currentProposal.id}/reject`
      );
      await loadProposals(false);
      renderProposalList();
    } catch (error) {
      alert(error.message);
    }
  }

  const refreshButton = $('#btn-refresh-proposals');
  if (refreshButton) refreshButton.addEventListener('click', () => loadProposals());

  App.proposals = {
    closeProposal,
    loadProposals,
    openProposal,
    openProposalFile,
    renderProposalDetail,
    renderProposalList,
    saveDecisions,
  };
})(window);
