(function (root) {
  const App = root.App;
  const state = App.state;
  const $ = App.$;
  const {
    canEditCurrentProject,
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
    state.editing = false;
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
    $('#doc-access-summary').textContent = state.currentProject.isOwner
      ? 'You own this project. You can lock, edit files, delete it, and manage sharing.'
      : state.currentProject.accessRole === 'editor'
        ? `You can edit this project after taking the lock. Shared by ${state.currentProject.sharedByUsername || 'unknown'}.`
        : `You can browse files, comment on Markdown files, and download the full repo history. Shared by ${state.currentProject.sharedByUsername || 'unknown'}.`;

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
            <button data-action="delete" class="danger">Delete</button>
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
          <div class="share-row-subtitle">${esc(App.helpers.capitalize(share.role))}</div>
        </div>
        <div class="share-row-actions">
          <button data-user-id="${share.userId}" class="danger">Remove</button>
        </div>
      </div>
    `).join('');
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
      await App.api('POST', `/projects/${state.currentProject.id}/rename`, { oldPath: item.path, newPath: nextPath });
      await refreshProjectState(item.isMarkdown && state.currentFile && state.currentFile.filePath === item.path ? nextPath : null);
      return;
    }
    if (action === 'delete') {
      if (!window.confirm(`Delete ${item.path}?`)) return;
      await App.api('DELETE', `/projects/${state.currentProject.id}/files`, { path: item.path });
      const wasCurrent = state.currentFile && state.currentFile.filePath === item.path;
      await refreshProjectState(wasCurrent ? '' : null);
    }
  }

  async function refreshProjectState(nextCurrentFilePath = null) {
    if (!state.currentProject) return;
    state.currentProject = await App.api('GET', `/projects/${state.currentProject.id}`);
    state.projectFiles = (await App.api('GET', `/projects/${state.currentProject.id}/files`)).items;
    if (canManageShares()) {
      state.projectShares = await App.api('GET', `/projects/${state.currentProject.id}/shares`);
    }
    renderProjectDetail();
    updateHeader();
    if (nextCurrentFilePath === '') {
      state.currentFile = null;
      $('#editor').value = '';
      $('#editor-file-label').textContent = 'Source';
      $('#preview').innerHTML = '';
      state.editing = false;
      return;
    }
    if (typeof nextCurrentFilePath === 'string' && nextCurrentFilePath) {
      await openMarkdownFile(nextCurrentFilePath, false);
    }
  }

  async function openMarkdownFile(filePath, switchView = true) {
    state.currentProject = await App.api('GET', `/projects/${state.currentProject.id}`);
    state.currentFile = await App.api('GET', `/projects/${state.currentProject.id}/files/content?path=${encodeURIComponent(filePath)}`);
    if (App.findReplace && App.findReplace.closeToolbar) App.findReplace.closeToolbar();
    $('#editor').value = state.currentFile.content || '';
    $('#editor-file-label').textContent = state.currentFile.filePath;
    state.editing = false;
    state.comparedDiff = null;
    state.comparedDiffBaselineContent = state.currentFile.content || '';
    state.comparedDiffDecisions = {};
    state.lastAppliedDiffAction = null;
    $('#diff-view').innerHTML = '';
    $('#diff-meta').textContent = '';
    $('#version-diff-actions').classList.add('hidden');
    App.preview.updatePreview();
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

  function renderDiff(diff) {
    $('#diff-view').innerHTML = diff.map((row) => {
      const prefix = row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' ';
      const lineActions = renderRowLineActions(row);
      const baseLine = row.baseLine ? `B${row.baseLine}` : '';
      const candLine = row.candLine ? `H${row.candLine}` : '';
      const lineMeta = [baseLine, candLine].filter(Boolean).join(' ');
      return `<div class="diff-line ${row.type}" data-prefix="${prefix}">
        <span class="diff-line-body">${renderRowText(row)}</span>
        ${lineActions}
        ${lineMeta ? `<span class="diff-line-meta">${esc(lineMeta)}</span>` : ''}
      </div>`;
    }).join('');
    $('#diff-view').querySelectorAll('.diff-action').forEach((button) => {
      button.addEventListener('click', () => applyDiffDecision(button.dataset.rowId, button.dataset.chunkId, button.dataset.action));
    });
  }

  async function loadVersions() {
    if (!state.currentFile) return;
    state.versions = await App.api('GET', `/projects/${state.currentProject.id}/files/versions?path=${encodeURIComponent(state.currentFile.filePath)}`);
    const baseSelect = $('#version-select-base');
    const headSelect = $('#version-select-head');
    const options = state.versions.map((version) => `
      <option value="${version.id}">v${version.version} · ${esc(version.author_name)} · ${esc(formatDate(version.created_at))}</option>
    `).join('');
    baseSelect.innerHTML = options;
    headSelect.innerHTML = options;
    if (state.versions[1]) {
      state.selectedBaseId = state.versions[1].id;
      state.selectedHeadId = state.versions[0].id;
    } else if (state.versions[0]) {
      state.selectedBaseId = state.versions[0].id;
      state.selectedHeadId = state.versions[0].id;
    }
    baseSelect.value = state.selectedBaseId || '';
    headSelect.value = state.selectedHeadId || '';
  }

  async function compareSelectedVersions() {
    if (!state.currentFile || !state.selectedBaseId || !state.selectedHeadId) return;
    const result = await App.api('POST', `/projects/${state.currentProject.id}/files/compare`, {
      path: state.currentFile.filePath,
      versionA: state.selectedBaseId,
      versionB: state.selectedHeadId
    });
    state.comparedDiff = result;
    state.comparedDiffBaselineContent = $('#editor').value;
    state.comparedDiffDecisions = {};
    state.lastAppliedDiffAction = null;
    renderDiff(result.diff);
    $('#diff-meta').textContent = `v${result.versionA} -> v${result.versionB}`;
    $('#version-diff-actions').classList.remove('hidden');
  }

  async function applyDiffDecision(rowId, chunkId, decision) {
    if (!state.currentProject || !state.currentFile || !state.comparedDiff) return;
    if (!canEditCurrentProject()) {
      alert('Edit access required.');
      return;
    }
    if (!holdsCurrentLock()) {
      alert('Take the project lock first.');
      return;
    }

    const nextDecisions = {
      ...state.comparedDiffDecisions,
      [decisionKey(rowId, chunkId)]: decision,
    };
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
    $('#editor').value = result.content;
    state.editing = true;
    App.preview.updatePreview();
    updateHeader();
    renderDiff(state.comparedDiff.diff);
  }

  async function revertSelectedVersion() {
    if (!state.selectedBaseId || !state.currentFile) return;
    if (!window.confirm('Revert file to the selected version? This creates a new version.')) return;
    const result = await App.api('POST', `/projects/${state.currentProject.id}/files/versions/${state.selectedBaseId}/revert`);
    await refreshProjectState(state.currentFile.filePath);
    $('#editor').value = result.content || '';
    state.editing = false;
    App.preview.updatePreview();
    await loadVersions();
  }

  App.projects = {
    compareSelectedVersions,
    downloadProjectRepo,
    handleFileAction,
    loadProjects,
    loadVersions,
    openMarkdownFile,
    openProjectDetail,
    refreshProjectState,
    renderProjectDetail,
    renderProjectLists,
    renderShares,
    revertSelectedVersion
  };
})(window);
