(function (root) {
  const App = root.App;
  const state = App.state;
  const $ = App.$;
  const {
    canEditCurrentProject,
    canDeleteProjectFiles,
    canManageShares,
    esc,
    formatDate,
    holdsCurrentLock,
    resetEditorState,
    showEditor,
    updateHeader
  } = App.helpers;

  async function loadProjects() {
    state.projects = await App.api('GET', '/projects');
    renderProjectLists();
  }

  function renderProjectCards(container, items) {
    if (!items.length) {
      container.innerHTML = '<div class="empty-state">No projects in this section.</div>';
      return;
    }
    container.innerHTML = items.map((project) => `
      <article class="document-card ${project.id === state.selectedProjectId ? 'active' : ''}" data-project-id="${project.id}">
        <div class="document-card-header">
          <div class="document-card-title">${esc(project.title)}</div>
          <div class="document-card-role">${App.helpers.capitalize(project.accessRole)}</div>
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
    renderProjectCards($('#owned-projects'), state.projects.filter((item) => item.isOwner));
    renderProjectCards($('#shared-projects'), state.projects.filter((item) => !item.isOwner));
  }

  async function openProjectDetail(projectId) {
    state.selectedProjectId = projectId;
    state.currentProject = await App.api('GET', `/projects/${projectId}`);
    state.projectFiles = (await App.api('GET', `/projects/${projectId}/files`)).items;
    state.projectShares = canManageShares() ? await App.api('GET', `/projects/${projectId}/shares`) : [];
    state.currentFile = null;
    state.currentProposal = null;
    state.editing = false;
    if (App.proposals && App.proposals.loadProposals) {
      await App.proposals.loadProposals(false);
    }
    if (App.comments && App.comments.syncAnchoredDraftFromStorage) {
      App.comments.syncAnchoredDraftFromStorage();
    }
    renderProjectLists();
    renderProjectDetail();
    updateHeader();
  }

  function renderProjectDetail() {
    $('#doc-detail-empty').classList.add('hidden');
    $('#doc-detail').classList.remove('hidden');
    $('#detail-title').textContent = state.currentProject.title;
    $('#detail-subtitle').textContent = state.currentProject.projectPath;
    $('#btn-delete-doc').classList.toggle('hidden', !state.currentProject.isOwner);
    $('#doc-metadata').innerHTML = `
      <dt>Role</dt><dd>${esc(App.helpers.capitalize(state.currentProject.accessRole))}</dd>
      <dt>Owner</dt><dd>${esc(state.currentProject.ownerUsername || 'Unknown')}</dd>
      <dt>Updated</dt><dd>${esc(formatDate(state.currentProject.updatedAt))}</dd>
      <dt>Commit</dt><dd>${esc(state.currentProject.currentCommitSha || 'No commits yet')}</dd>
    `;
    const sharedBy = state.currentProject.sharedByUsername || 'unknown';
    $('#doc-access-summary').textContent = state.currentProject.isOwner
      ? 'You own this project. You can edit and delete files, delete the project, and manage sharing.'
      : state.currentProject.accessRole === 'admin'
        ? `You can edit and delete files and manage sharing. Shared by ${sharedBy}.`
        : state.currentProject.accessRole === 'editor'
          ? `You can edit this project after taking the lock, but cannot delete files or manage sharing. Shared by ${sharedBy}.`
          : `You can browse files, comment on Markdown files, and download the full repo history. Shared by ${sharedBy}.`;

    const fileList = $('#project-files');
    if (!state.projectFiles.length) {
      fileList.innerHTML = '<div class="empty-state">This project is empty.</div>';
    } else {
      fileList.innerHTML = state.projectFiles.map((item) => `
        <div class="share-row file-row">
          <div class="file-row-meta">
            <div class="file-row-path">${esc(item.path)}</div>
            <div class="file-row-subtitle">${item.kind === 'dir' ? 'Folder' : (item.isMarkdown ? 'Markdown file' : 'Asset')}</div>
          </div>
          <div class="file-row-actions">
            ${item.isMarkdown ? '<button data-action="open">Open</button>' : ''}
            <button data-action="rename">Rename</button>
            ${canDeleteProjectFiles() ? '<button data-action="delete" class="danger">Delete</button>' : ''}
          </div>
        </div>
      `).join('');
      fileList.querySelectorAll('.file-row').forEach((row, index) => {
        const item = state.projectFiles[index];
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
    if (App.proposals && App.proposals.renderProposalList) {
      App.proposals.renderProposalList();
    }
  }

  function downloadProjectRepo() {
    if (!state.currentProject) return;
    window.location.href = `${App.constants.API}/projects/${state.currentProject.id}/download`;
  }

  function renderShares() {
    const list = $('#share-list');
    if (!canManageShares()) {
      list.innerHTML = '';
      return;
    }
    if (!state.projectShares.length) {
      list.innerHTML = '<div class="empty-state">This project has not been shared yet.</div>';
      return;
    }
    list.innerHTML = state.projectShares.map((share) => `
      <div class="share-row">
        <div class="share-row-meta">
          <div class="share-row-username">${esc(share.username)}</div>
          <div class="share-row-subtitle">Change role</div>
        </div>
        <div class="share-row-actions">
          <select data-share-role data-user-id="${share.userId}" data-current-role="${share.role}" aria-label="Role for ${esc(share.username)}">
            ${['viewer', 'editor', 'admin'].map((role) => (
              `<option value="${role}"${share.role === role ? ' selected' : ''}>${App.helpers.capitalize(role)}</option>`
            )).join('')}
          </select>
          <button data-user-id="${share.userId}" class="danger">Remove</button>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('select[data-share-role]').forEach((select) => {
      select.addEventListener('change', async () => {
        const share = state.projectShares.find((item) => item.userId === select.dataset.userId);
        if (!share || select.value === share.role) return;
        const error = $('#share-error');
        error.classList.add('hidden');
        select.disabled = true;
        try {
          await App.api('POST', `/projects/${state.currentProject.id}/shares`, {
            username: share.username,
            role: select.value
          });
          state.projectShares = await App.api('GET', `/projects/${state.currentProject.id}/shares`);
          renderShares();
        } catch (err) {
          select.value = share.role;
          select.disabled = false;
          error.textContent = err.message;
          error.classList.remove('hidden');
        }
      });
    });
    list.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', async () => {
        await App.api('DELETE', `/projects/${state.currentProject.id}/shares/${button.dataset.userId}`);
        state.projectShares = await App.api('GET', `/projects/${state.currentProject.id}/shares`);
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
      const currentPath = state.currentFile && state.currentFile.filePath;
      const renamedCurrentPath = currentPath === item.path ? nextPath : (currentPath && currentPath.startsWith(`${item.path}/`) ? `${nextPath}${currentPath.slice(item.path.length)}` : null);
      const result = await App.api('POST', `/projects/${state.currentProject.id}/rename`, { oldPath: item.path, newPath: nextPath });
      if (state.currentFile && !renamedCurrentPath) state.currentFile.currentCommitSha = result.currentCommitSha;
      await refreshProjectState(renamedCurrentPath);
      return;
    }
    if (action === 'delete') {
      if (!canDeleteProjectFiles()) {
        alert('Admin or owner access required to delete files.');
        return;
      }
      if (!window.confirm(`Delete ${item.path}?`)) return;
      const currentPath = state.currentFile && state.currentFile.filePath;
      const removesCurrent = currentPath === item.path || (currentPath && currentPath.startsWith(`${item.path}/`));
      const result = await App.api('DELETE', `/projects/${state.currentProject.id}/files`, { path: item.path });
      if (state.currentFile && !removesCurrent) state.currentFile.currentCommitSha = result.currentCommitSha;
      await refreshProjectState(removesCurrent ? '' : null);
    }
  }

  async function refreshProjectState(nextCurrentFilePath = null) {
    if (!state.currentProject) return;
    state.currentProject = await App.api('GET', `/projects/${state.currentProject.id}`);
    state.projectFiles = (await App.api('GET', `/projects/${state.currentProject.id}/files`)).items;
    if (canManageShares()) {
      state.projectShares = await App.api('GET', `/projects/${state.currentProject.id}/shares`);
    }
    if (App.proposals && App.proposals.loadProposals) {
      await App.proposals.loadProposals(false);
    }
    renderProjectDetail();
    updateHeader();
    if (nextCurrentFilePath === '') {
      state.currentFile = null;
      state.suspendEditorChangeTracking = true;
      App.editor.setValue('');
      state.suspendEditorChangeTracking = false;
      $('#editor-file-label').textContent = 'Source';
      $('#preview').innerHTML = '';
      state.editing = false;
      if (App.comments && App.comments.syncAnchoredDraftFromStorage) {
        App.comments.syncAnchoredDraftFromStorage();
      }
      return;
    }
    if (typeof nextCurrentFilePath === 'string' && nextCurrentFilePath) {
      await openMarkdownFile(nextCurrentFilePath, false);
    }
  }

  async function openMarkdownFile(filePath, switchView = true) {
    const active = state.activeProposalReview;
    if (active && active.needsSave && active.filePath !== filePath) {
      if (!window.confirm('Discard the unsaved reviewed changes and open another file?')) return;
    }
    state.currentProject = await App.api('GET', `/projects/${state.currentProject.id}`);
    state.currentFile = await App.api('GET', `/projects/${state.currentProject.id}/files/content?path=${encodeURIComponent(filePath)}`);
    if (App.findReplace && App.findReplace.closeToolbar) App.findReplace.closeToolbar();
    state.suspendEditorChangeTracking = true;
    App.editor.setValue(state.currentFile.content || '');
    state.suspendEditorChangeTracking = false;
    $('#editor-file-label').textContent = state.currentFile.filePath;
    state.editing = false;
    state.comparedDiff = null;
    state.comparedDiffBaselineContent = state.currentFile.content || '';
    state.comparedDiffDecisions = {};
    state.lastAppliedDiffAction = null;
    state.activeProposalReview = null;
    $('#diff-view').innerHTML = '';
    $('#diff-meta').textContent = '';
    $('#version-diff-actions').classList.add('hidden');
    $('#btn-revert').classList.remove('hidden');
    App.preview.updatePreview();
    if (App.comments && App.comments.syncAnchoredDraftFromStorage) {
      App.comments.syncAnchoredDraftFromStorage();
    }
    updateHeader();
    if (switchView) showEditor();
  }

  function decisionKey(rowId, chunkId) {
    return `${rowId}::${chunkId}`;
  }

  function currentChunkDecision(rowId, chunkId) {
    return state.comparedDiffDecisions[decisionKey(rowId, chunkId)] || '';
  }

  function canApplyDiffChunks() {
    if (state.comparedDiff && state.comparedDiff.proposalId) {
      return !!state.comparedDiff.reviewerCanDecide && holdsCurrentLock();
    }
    return canEditCurrentProject() && holdsCurrentLock();
  }

  function shouldRenderChunkActions(row, chunk) {
    if (!chunk) return false;
    if (chunk.kind === 'line-add') return true;
    if (chunk.kind === 'line-remove') return true;
    return row.type === 'added';
  }

  function renderChunkActions(row, chunk) {
    if (!shouldRenderChunkActions(row, chunk)) return '';
    const disabled = canApplyDiffChunks() ? '' : ' disabled';
    const decision = currentChunkDecision(row.rowId, chunk.chunkId);
    const acceptClass = decision === 'accept' ? ' active' : '';
    const refuseClass = decision === 'refuse' ? ' active' : '';
    return `<span class="diff-chunk-actions">
      <button class="diff-action accept${acceptClass}" data-action="accept" data-row-id="${row.rowId}" data-chunk-id="${chunk.chunkId}"${disabled}>Accept</button>
      <button class="diff-action refuse${refuseClass}" data-action="refuse" data-row-id="${row.rowId}" data-chunk-id="${chunk.chunkId}"${disabled}>Refuse</button>
    </span>`;
  }

  function renderRowText(row) {
    const chunksById = Object.fromEntries((row.chunks || []).map((chunk) => [chunk.chunkId, chunk]));
    const segments = row.segments || [{ text: row.line || '', changed: false }];
    return segments.map((segment) => {
      if (!segment.changed || !segment.chunkId) return esc(segment.text);
      const chunk = chunksById[segment.chunkId];
      const actionMarkup = chunk && chunk.kind === 'replace' && row.type === 'added'
        ? renderChunkActions(row, chunk)
        : '';
      return `<span class="diff-token-changed">${esc(segment.text)}${actionMarkup}</span>`;
    }).join('');
  }

  function renderRowLineActions(row) {
    if (!row.chunks || row.chunks.length !== 1) return '';
    const chunk = row.chunks[0];
    if (chunk.kind !== 'line-add' && chunk.kind !== 'line-remove') return '';
    return renderChunkActions(row, chunk);
  }

  function allDiffChunkDecisions(decision, rowId = '') {
    if (!state.comparedDiff) return [];
    const decisions = new Map();
    state.comparedDiff.diff.forEach((row) => {
      if (rowId && row.rowId !== rowId) return;
      (row.chunks || []).forEach((chunk) => {
        if (!shouldRenderChunkActions(row, chunk)) return;
        decisions.set(decisionKey(row.rowId, chunk.chunkId), {
          rowId: row.rowId,
          chunkId: chunk.chunkId,
          decision,
        });
      });
    });
    return [...decisions.values()];
  }

  function renderBlockAcceptAll(row) {
    const items = allDiffChunkDecisions('accept', row.rowId);
    if (items.length < 2) return '';
    const allAccepted = items.every((item) => (
      currentChunkDecision(item.rowId, item.chunkId) === 'accept'
    ));
    const disabled = canApplyDiffChunks() ? '' : ' disabled';
    return `<span class="diff-chunk-actions">
      <button type="button" class="diff-action accept${allAccepted ? ' active' : ''}"
        data-accept-all-row-id="${esc(row.rowId)}" aria-pressed="${allAccepted ? 'true' : 'false'}"${disabled}>Accept line</button>
    </span>`;
  }


  function renderDiff(diff) {
    $('#diff-view').innerHTML = diff.map((row) => {
      const prefix = row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' ';
      const lineActions = renderRowLineActions(row);
      const blockActions = renderBlockAcceptAll(row);
      const baseLine = row.baseLine ? `B${row.baseLine}` : '';
      const candLine = row.candLine ? `H${row.candLine}` : '';
      const lineMeta = [baseLine, candLine].filter(Boolean).join(' ');
      return `<div class="diff-line ${row.type}" data-prefix="${prefix}">
        <span class="diff-line-body">${renderRowText(row)}</span>
        ${lineActions}
        ${blockActions}
        ${lineMeta ? `<span class="diff-line-meta">${esc(lineMeta)}</span>` : ''}
      </div>`;
    }).join('');
    $('#diff-view').querySelectorAll('.diff-action[data-action]').forEach((button) => {
      button.addEventListener('click', () => applyDiffDecision(button.dataset.rowId, button.dataset.chunkId, button.dataset.action));
    });
    $('#diff-view').querySelectorAll('[data-accept-all-row-id]').forEach((button) => {
      button.addEventListener('click', () => acceptAllDiffChunks(button.dataset.acceptAllRowId));
    });
  }

  function versionOption(version) {
    const label = version.kind === 'proposal'
      ? `Proposed · ${version.author_name} · ${version.message || 'Untitled revision'} · ${formatDate(version.created_at)}`
      : `v${version.version} · ${version.author_name} · ${formatDate(version.created_at)}`;
    return `<option value="${esc(version.id)}">${esc(label)}</option>`;
  }

  async function loadVersions() {
    if (!state.currentFile) return;
    state.versions = await App.api('GET', `/projects/${state.currentProject.id}/files/versions?path=${encodeURIComponent(state.currentFile.filePath)}`);
    const baseSelect = $('#version-select-base');
    const headSelect = $('#version-select-head');
    const published = state.versions.filter((version) => version.kind !== 'proposal');
    const proposals = state.versions.filter((version) => version.kind === 'proposal');
    baseSelect.innerHTML = published.map(versionOption).join('');
    headSelect.innerHTML = [...proposals, ...published].map(versionOption).join('');

    if (proposals.length) {
      state.selectedBaseId = proposals[0].baseVersionId || (published[0] ? published[0].id : null);
      state.selectedHeadId = proposals[0].id;
    } else if (published[1]) {
      state.selectedBaseId = published[1].id;
      state.selectedHeadId = published[0].id;
    } else if (published[0]) {
      state.selectedBaseId = published[0].id;
      state.selectedHeadId = published[0].id;
    } else {
      state.selectedBaseId = null;
      state.selectedHeadId = null;
    }
    baseSelect.value = state.selectedBaseId || '';
    headSelect.value = state.selectedHeadId || '';
  }


  function syncProposalBase(versionId) {
    const version = state.versions.find((item) => item.id === versionId);
    if (!version || version.kind !== 'proposal' || !version.baseVersionId) return;
    state.selectedBaseId = version.baseVersionId;
    $('#version-select-base').value = version.baseVersionId;
  }

  async function projectActiveProposalReview(needsSave = true) {
    const review = state.activeProposalReview;
    if (!review || !state.currentFile || review.filePath !== state.currentFile.filePath) return;
    const result = await App.api(
      'POST',
      `/projects/${state.currentProject.id}/proposals/${review.proposalId}/preview`,
      {
        filePath: review.filePath,
        baselineContent: state.comparedDiffBaselineContent,
      }
    );
    const differsFromSavedFile = result.content !== (state.currentFile.content || '');
    state.suspendEditorChangeTracking = true;
    App.editor.setValue(result.content);
    state.suspendEditorChangeTracking = false;
    review.needsSave = needsSave;
    state.editing = state.editing || needsSave || differsFromSavedFile;
    App.preview.updatePreview();
    updateHeader();
  }

  async function refreshActiveProposalReview(proposal) {
    const review = state.activeProposalReview;
    if (!review || !proposal || review.proposalId !== proposal.id) return;
    const file = proposal.files.find((item) => item.filePath === review.filePath);
    if (!file) return;
    state.comparedDiffDecisions = Object.fromEntries(
      file.reviewItems
        .filter((item) => item.decision)
        .map((item) => [`${item.rowId}::${item.chunkId}`, item.decision])
    );
    review.needsSave = file.needsSave;
    renderDiff(state.comparedDiff.diff);
    await projectActiveProposalReview(file.needsSave);
  }

  function selectedProposalId() {
    const selected = state.versions.find((item) => item.id === state.selectedHeadId);
    return selected && selected.kind === 'proposal' ? selected.proposalId : null;
  }

  async function compareSelectedVersions() {
    if (!state.currentFile || !state.selectedBaseId || !state.selectedHeadId) return;
    const active = state.activeProposalReview;
    const nextProposalId = selectedProposalId();
    const sameWorkingReview = active
      && active.proposalId === nextProposalId
      && active.versionAId === state.selectedBaseId
      && active.versionBId === state.selectedHeadId;
    let comparisonBaselineContent = sameWorkingReview
      ? state.comparedDiffBaselineContent
      : null;
    if (active && active.needsSave && !sameWorkingReview) {
      if (!window.confirm('Discard the unsaved reviewed changes and start another comparison?')) return;
      state.suspendEditorChangeTracking = true;
      App.editor.setValue(state.currentFile.content || '');
      state.suspendEditorChangeTracking = false;
      state.editing = false;
      state.activeProposalReview = null;
      App.preview.updatePreview();
      updateHeader();
    }
    if (comparisonBaselineContent === null) {
      comparisonBaselineContent = App.editor.getValue();
    }
    const result = await App.api('POST', `/projects/${state.currentProject.id}/files/compare`, {
      path: state.currentFile.filePath,
      versionA: state.selectedBaseId,
      versionB: state.selectedHeadId
    });
    state.comparedDiff = result;
    state.comparedDiffBaselineContent = comparisonBaselineContent;
    state.comparedDiffDecisions = result.proposalDecisions || {};
    state.lastAppliedDiffAction = null;
    renderDiff(result.diff);
    const reviewHint = result.proposalId && !result.proposalBaseMatches
      ? ' · comparison only; select the proposal base to review'
      : '';
    $('#diff-meta').textContent = `${result.labelA} → ${result.labelB}${reviewHint}`;
    $('#btn-revert').classList.toggle('hidden', !!result.proposalId);
    $('#version-diff-actions').classList.remove('hidden');
    if (result.proposalId && result.reviewerCanDecide) {
      state.activeProposalReview = {
        proposalId: result.proposalId,
        filePath: state.currentFile.filePath,
        versionAId: result.versionAId,
        versionBId: result.versionBId,
        needsSave: false,
      };
      if (Object.keys(state.comparedDiffDecisions).length) {
        await projectActiveProposalReview(!result.proposalDecisionSnapshotApplied);
      }
    } else if (!result.proposalId) {
      state.activeProposalReview = null;
    }
  }

  async function applyDiffDecision(rowId, chunkId, decision) {
    if (!state.currentProject || !state.currentFile || !state.comparedDiff) return;
    if (!canEditCurrentProject()) {
      alert('Edit access required.');
      return;
    }

    const key = decisionKey(rowId, chunkId);
    const nextDecisions = {
      ...state.comparedDiffDecisions,
      [key]: decision,
    };

    if (state.comparedDiff.proposalId) {
      if (!state.comparedDiff.reviewerCanDecide) {
        alert('Select the proposal base and ensure you have edit access.');
        return;
      }
      const result = await App.api(
        'PUT',
        `/projects/${state.currentProject.id}/proposals/${state.comparedDiff.proposalId}/decisions`,
        { items: [{
          kind: 'diff',
          filePath: state.currentFile.filePath,
          itemId: key,
          decision,
        }] }
      );
      state.comparedDiffDecisions = nextDecisions;
      state.lastAppliedDiffAction = { rowId, chunkId, decision };
      if (state.currentProposal && state.currentProposal.id === result.id) {
        state.currentProposal = result;
      }
      state.activeProposalReview = {
        ...(state.activeProposalReview || {}),
        proposalId: state.comparedDiff.proposalId,
        filePath: state.currentFile.filePath,
        versionAId: state.comparedDiff.versionAId,
        versionBId: state.comparedDiff.versionBId,
        needsSave: true,
      };
      renderDiff(state.comparedDiff.diff);
      await projectActiveProposalReview();
      return;
    }

    if (!holdsCurrentLock()) {
      alert('Take the project lock first.');
      return;
    }
    const payloadDecisions = Object.entries(nextDecisions).map(([key, value]) => {
      const [decisionRowId, decisionChunkId] = key.split('::');
      return {
        rowId: decisionRowId,
        chunkId: decisionChunkId,
        decision: value,
      };
    });

    const result = await App.api('POST', `/projects/${state.currentProject.id}/files/apply-diff-chunk`, {
      path: state.currentFile.filePath,
      versionA: state.comparedDiff.versionAId,
      versionB: state.comparedDiff.versionBId,
      currentContent: state.comparedDiffBaselineContent,
      rowId,
      chunkId,
      decision,
      decisions: payloadDecisions,
    });

    state.comparedDiffDecisions = nextDecisions;
    state.lastAppliedDiffAction = { rowId, chunkId, decision };
    state.comparedDiff = {
      ...state.comparedDiff,
      diff: result.diff || state.comparedDiff.diff,
    };
    App.editor.setValue(result.content);
    state.editing = true;
    App.preview.updatePreview();
    updateHeader();
    renderDiff(state.comparedDiff.diff);
  }

  async function acceptAllDiffChunks(rowId) {
    if (!state.currentProject || !state.currentFile || !state.comparedDiff) return;
    if (!canEditCurrentProject()) {
      alert('Edit access required.');
      return;
    }

    const items = allDiffChunkDecisions('accept', rowId);
    if (!items.length) return;
    const nextDecisions = { ...state.comparedDiffDecisions };
    items.forEach((item) => {
      nextDecisions[decisionKey(item.rowId, item.chunkId)] = 'accept';
    });

    if (state.comparedDiff.proposalId) {
      if (!state.comparedDiff.reviewerCanDecide) {
        alert('Select the proposal base and ensure you have edit access.');
        return;
      }
      const result = await App.api(
        'PUT',
        `/projects/${state.currentProject.id}/proposals/${state.comparedDiff.proposalId}/decisions`,
        { items: items.map((item) => ({
          kind: 'diff',
          filePath: state.currentFile.filePath,
          itemId: decisionKey(item.rowId, item.chunkId),
          decision: item.decision,
        })) }
      );
      state.comparedDiffDecisions = nextDecisions;
      state.lastAppliedDiffAction = { decision: 'accept-all' };
      if (state.currentProposal && state.currentProposal.id === result.id) {
        state.currentProposal = result;
      }
      state.activeProposalReview = {
        ...(state.activeProposalReview || {}),
        proposalId: state.comparedDiff.proposalId,
        filePath: state.currentFile.filePath,
        versionAId: state.comparedDiff.versionAId,
        versionBId: state.comparedDiff.versionBId,
        needsSave: true,
      };
      renderDiff(state.comparedDiff.diff);
      await projectActiveProposalReview();
      return;
    }

    if (!holdsCurrentLock()) {
      alert('Take the project lock first.');
      return;
    }
    const first = items[0];
    const payloadDecisions = Object.entries(nextDecisions).map(([key, value]) => {
      const [rowId, chunkId] = key.split('::');
      return { rowId, chunkId, decision: value };
    });
    const result = await App.api('POST', `/projects/${state.currentProject.id}/files/apply-diff-chunk`, {
      path: state.currentFile.filePath,
      versionA: state.comparedDiff.versionAId,
      versionB: state.comparedDiff.versionBId,
      currentContent: state.comparedDiffBaselineContent,
      rowId: first.rowId,
      chunkId: first.chunkId,
      decision: first.decision,
      decisions: payloadDecisions,
    });

    state.comparedDiffDecisions = nextDecisions;
    state.lastAppliedDiffAction = { decision: 'accept-all' };
    state.comparedDiff = {
      ...state.comparedDiff,
      diff: result.diff || state.comparedDiff.diff,
    };
    App.editor.setValue(result.content);
    state.editing = true;
    App.preview.updatePreview();
    updateHeader();
    renderDiff(state.comparedDiff.diff);
  }

  async function revertSelectedVersion() {
    if (!state.selectedBaseId || !state.currentFile) return;
    const selected = state.versions.find((version) => version.id === state.selectedBaseId);
    if (!selected || selected.kind === 'proposal') return;
    const laterCount = state.versions.filter(
      (version) => version.kind !== 'proposal' && version.version > selected.version
    ).length;
    const warning = laterCount
      ? `Roll back to v${selected.version}? This permanently deletes ${laterCount} later version${laterCount === 1 ? '' : 's'} and comments added after it. Comments that existed then will be restored and reopened.`
      : `Restore v${selected.version}? Comments that existed then will be restored and reopened.`;
    if (!window.confirm(warning)) return;
    const result = await App.api('POST', `/projects/${state.currentProject.id}/files/versions/${state.selectedBaseId}/rollback`);
    await refreshProjectState(state.currentFile.filePath);
    state.suspendEditorChangeTracking = true;
    App.editor.setValue(result.content || '');
    state.suspendEditorChangeTracking = false;
    state.editing = false;
    App.preview.updatePreview();
    await loadVersions();
    window.alert(`Rolled back to v${result.rolledBackToVersion}. Deleted ${result.deletedVersions} later version${result.deletedVersions === 1 ? '' : 's'} and restored ${result.restoredThreads} comment thread${result.restoredThreads === 1 ? '' : 's'}.`);
  }

  App.projects = {
    compareSelectedVersions,
    downloadProjectRepo,
    handleFileAction,
    loadProjects,
    loadVersions,
    openMarkdownFile,
    openProjectDetail,
    refreshActiveProposalReview,
    refreshProjectState,
    renderProjectDetail,
    renderProjectLists,
    renderShares,
    revertSelectedVersion,
    syncProposalBase
  };
})(window);
