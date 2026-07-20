(function (root) {
  const App = root.App;
  const state = App.state;
  const $ = App.$;
  const { capitalize, esc, formatDate } = App.helpers;

  function statusLabel(status) {
    return capitalize(status || 'pending');
  }

  function canReview(proposal) {
    return !!state.currentUser
      && !!state.currentProject
      && ['owner', 'editor'].includes(state.currentProject.accessRole)
      && proposal.status === 'pending';
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
    state.currentProposal = await App.api(
      'GET',
      `/projects/${state.currentProject.id}/proposals/${proposalId}`
    );
    renderProposalList();
  }

  function closeProposal() {
    state.currentProposal = null;
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
    return `<section class="proposal-file">
      <h4>${esc(file.filePath)}</h4>
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
        <span>${esc(action.filePath)} · ${esc(action.threadId)}</span>
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
    list.classList.add('hidden');
    review.classList.remove('hidden');
    const reviewerEnabled = canReview(proposal);
    const deleteEnabled = canDeleteProposal(proposal);
    const staleNotice = proposal.staleReason
      ? `<div class="proposal-notice danger">${esc(proposal.staleReason)} Ask Codex to regenerate from the current project.</div>`
      : '';
    const progress = `${proposal.review.decided} of ${proposal.review.required} items decided`;
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
        <strong>${esc(progress)}</strong>
      </div>
      ${staleNotice}
      ${reviewerEnabled ? `<div class="proposal-bulk-actions">
        <button type="button" data-bulk-decision="accept">Accept all</button>
        <button type="button" data-bulk-decision="refuse">Refuse all</button>
      </div>` : ''}
      <div class="proposal-files">
        ${proposal.files.map((file) => renderFileDiff(file, reviewerEnabled)).join('')}
      </div>
      ${proposal.commentActions.length ? `<section class="proposal-comments">
        <h4>Comment actions</h4>
        ${proposal.commentActions.map((action) => renderCommentAction(action, reviewerEnabled)).join('')}
      </section>` : ''}
      ${reviewerEnabled || deleteEnabled ? `<div class="proposal-publish-actions">
        ${reviewerEnabled ? '<button type="button" id="btn-reject-proposal" class="danger">Reject proposal</button>' : ''}
        ${deleteEnabled ? '<button type="button" id="btn-delete-proposal" class="danger">Delete proposal</button>' : ''}
        ${reviewerEnabled ? `<button type="button" id="btn-publish-proposal" class="primary"${proposal.review.canPublish ? '' : ' disabled'}>Publish accepted changes</button>` : ''}
      </div>` : ''}
      ${proposal.status === 'accepted' && proposal.appliedCommitSha
        ? `<div class="proposal-notice success">Published as commit ${esc(proposal.appliedCommitSha.slice(0, 10))} by ${esc(proposal.reviewerUsername || 'reviewer')}.</div>`
        : ''}
    `;
    bindProposalDetailEvents();
  }

  function bindProposalDetailEvents() {
    $('#btn-close-proposal').addEventListener('click', closeProposal);
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
    const publish = $('#btn-publish-proposal');
    if (publish) publish.addEventListener('click', publishProposal);
    const reject = $('#btn-reject-proposal');
    if (reject) reject.addEventListener('click', rejectProposal);
    const remove = $('#btn-delete-proposal');
    if (remove) remove.addEventListener('click', deleteProposal);
  }

  async function saveDecisions(items) {
    if (!items.length) return;
    try {
      state.currentProposal = await App.api(
        'PUT',
        `/projects/${state.currentProject.id}/proposals/${state.currentProposal.id}/decisions`,
        { items }
      );
      renderProposalDetail();
    } catch (error) {
      alert(error.message);
      await openProposal(state.currentProposal.id);
    }
  }

  async function publishProposal() {
    if (!window.confirm('Publish every accepted item as one new project version?')) return;
    try {
      state.currentProposal = await App.api(
        'POST',
        `/projects/${state.currentProject.id}/proposals/${state.currentProposal.id}/publish`
      );
      await App.projects.refreshProjectState();
      await loadProposals(false);
      const accepted = state.proposals.find((item) => item.id === state.currentProposal.id);
      if (accepted) state.currentProposal = await App.api(
        'GET',
        `/projects/${state.currentProject.id}/proposals/${accepted.id}`
      );
      renderProposalList();
    } catch (error) {
      alert(error.message);
      await openProposal(state.currentProposal.id);
    }
  }

  async function deleteProposal() {
    const proposal = state.currentProposal;
    if (!proposal || !window.confirm('Delete this unpublished proposal permanently? Live project files will not be changed.')) return;
    try {
      await App.api(
        'DELETE',
        `/projects/${state.currentProject.id}/proposals/${proposal.id}`
      );
      state.currentProposal = null;
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
    renderProposalDetail,
    renderProposalList,
  };
})(window);
