(function (root) {
  const App = root.App || (root.App = {});
  const state = App.state;
  const $ = App.$;

  function getLineNumberAtOffset(text, offset) {
    let lineNumber = 1;
    for (let i = 0; i < offset && i < text.length; i += 1) {
      if (text[i] === '\n') lineNumber += 1;
    }
    return lineNumber;
  }

  function preprocessMath(md, lineOffset = 0, sourceOffset = 0) {
    const source = md;
    state.mathPlaceholders = {};
    state.placeholderCounter = 0;

    return md.replace(/\$\$([\s\S]+?)\$\$|\$([^\$\n]+?)\$/g, (match, blockMath, inlineMath, offset) => {
      const type = blockMath !== undefined ? 'block' : 'inline';
      const math = type === 'block' ? blockMath.trim() : inlineMath;
      const key = `{MATH${type === 'block' ? 'B' : 'I'}:${state.placeholderCounter++}}`;
      state.mathPlaceholders[key] = {
        type,
        math,
        line: lineOffset + getLineNumberAtOffset(source, offset),
        sourceStart: sourceOffset + offset,
        sourceEnd: sourceOffset + offset + match.length
      };
      return type === 'block' ? `\n\n${key}\n\n` : ` ${key} `;
    });
  }

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function postprocessMath(html) {
    for (const [key, { type, math, line, sourceStart, sourceEnd }] of Object.entries(state.mathPlaceholders)) {
      let rendered;
      try {
        rendered = root.katex.renderToString(math, {
          throwOnError: false,
          displayMode: type === 'block'
        });
      } catch {
        rendered = `<code>${escapeHtml(math)}</code>`;
      }
      const lineAttr = line ? ` data-line="${line}"` : '';
      const sourceAttrs = ` data-source-start="${sourceStart}" data-source-end="${sourceEnd}"`;
      const wrapper = type === 'block'
        ? `<div class="math-block"${lineAttr}${sourceAttrs}>${rendered}</div>`
        : `<span class="math-inline"${lineAttr}${sourceAttrs}>${rendered}</span>`;
      html = html.split(key).join(wrapper);
    }
    return html;
  }

  function renderHighlight(container) {
    container.querySelectorAll('pre code').forEach((block) => {
      try {
        root.hljs.highlightElement(block);
      } catch {}
    });
  }

  function resolveProjectImageUrl(source, projectId, filePath, apiBase) {
    if (!source || !projectId || !filePath || !apiBase) return source;
    const value = source.trim();
    if (
      !value
      || value.startsWith('/')
      || value.startsWith('#')
      || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
    ) {
      return source;
    }

    const suffixIndex = value.search(/[?#]/);
    const relativePath = suffixIndex === -1 ? value : value.slice(0, suffixIndex);
    const suffix = suffixIndex === -1 ? '' : value.slice(suffixIndex);
    const segments = filePath.split('/').slice(0, -1);

    for (const rawSegment of relativePath.split('/')) {
      let segment;
      try {
        segment = decodeURIComponent(rawSegment);
      } catch {
        return source;
      }
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (!segments.length) return source;
        segments.pop();
        continue;
      }
      if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) return source;
      segments.push(segment);
    }

    if (!segments.length) return source;
    const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join('/');
    const base = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
    return `${base}/projects/${encodeURIComponent(projectId)}/assets/${encodedPath}${suffix}`;
  }

  function rewriteProjectImageSources(container) {
    const project = state.currentProject;
    const file = state.currentFile;
    const apiBase = App.constants && App.constants.API;
    if (!container || !project || !file || !apiBase) return;
    container.querySelectorAll('img[src]').forEach((image) => {
      const source = image.getAttribute('src');
      const resolved = resolveProjectImageUrl(source, project.id, file.filePath, apiBase);
      if (resolved !== source) image.setAttribute('src', resolved);
    });
  }

  function getLineMatchTokens(text) {
    return String(text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
  }

  function lineMatchesRenderedText(sourceLine, renderedText) {
    const line = String(sourceLine || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const text = String(renderedText || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!line || !text) return false;
    if (line.includes(text.slice(0, 80))) return true;

    const expected = getLineMatchTokens(text).slice(0, 4);
    const available = getLineMatchTokens(line);
    if (!expected.length) return false;
    let expectedIndex = 0;
    for (const token of available) {
      if (token === expected[expectedIndex]) expectedIndex += 1;
      if (expectedIndex === expected.length) return true;
    }
    return false;
  }

  function findSourceLineForRenderedText(lines, renderedText, startIndex = 0) {
    if (!Array.isArray(lines) || !renderedText) return -1;
    const firstIndex = Math.max(0, Number.isFinite(startIndex) ? startIndex : 0);
    for (let index = firstIndex; index < lines.length; index += 1) {
      if (lineMatchesRenderedText(lines[index], renderedText)) return index;
    }
    return -1;
  }

  function getElementTextProbe(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const value = node.textContent.replace(/\s+/g, ' ').trim();
      if (value) return value;
    }
    return '';
  }

  function annotateLines(container, source, lineOffset = 0) {
    const lines = source.split('\n');
    const blockEls = container.querySelectorAll('h1, h2, h3, h4, h5, h6, p, pre, li, tr, td, th, div.math-block, hr');
    let nextSourceLine = 0;

    for (const el of blockEls) {
      if (el.matches('li') && [...el.children].some((child) => child.matches('p'))) continue;
      if (el.matches('td, th')) {
        const row = el.closest('tr[data-line]');
        if (row) {
          el.setAttribute('data-line', row.getAttribute('data-line'));
          continue;
        }
      }
      if (el.hasAttribute('data-line')) {
        const existingLine = parseInt(el.getAttribute('data-line'), 10) - lineOffset - 1;
        if (Number.isFinite(existingLine)) nextSourceLine = Math.max(nextSourceLine, existingLine + 1);
        continue;
      }
      let lineIndex = -1;
      if (el.matches('hr')) {
        for (let index = nextSourceLine; index < lines.length; index += 1) {
          if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(lines[index])) {
            lineIndex = index;
            break;
          }
        }
      } else {
        lineIndex = findSourceLineForRenderedText(lines, getElementTextProbe(el), nextSourceLine);
      }
      if (lineIndex === -1) continue;
      el.setAttribute('data-line', lineOffset + lineIndex + 1);
      nextSourceLine = lineIndex + 1;
    }
  }

  function getLineStartOffset(source, lineNumber) {
    if (lineNumber <= 1) return 0;
    let offset = 0;
    let currentLineNumber = 1;
    while (currentLineNumber < lineNumber && offset < source.length) {
      const nextBreak = source.indexOf('\n', offset);
      if (nextBreak === -1) return source.length;
      offset = nextBreak + 1;
      currentLineNumber += 1;
    }
    return offset;
  }

  function getLineEndOffset(source, lineNumber) {
    const nextLineStart = getLineStartOffset(source, lineNumber + 1);
    return nextLineStart > 0 ? nextLineStart - 1 : source.length;
  }

  function getLineTextAt(source, lineNumber) {
    const start = getLineStartOffset(source, lineNumber);
    const end = source.indexOf('\n', start);
    return source.slice(start, end === -1 ? source.length : end);
  }

  function getPreviewCaretAtPoint(event) {
    if (document.caretPositionFromPoint) {
      const caret = document.caretPositionFromPoint(event.clientX, event.clientY);
      if (caret) return { node: caret.offsetNode, offset: caret.offset };
    }
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(event.clientX, event.clientY);
      if (range) return { node: range.startContainer, offset: range.startOffset };
    }
    return null;
  }

  function getRenderedTextOffset(container, node, offset) {
    if (!container || !node) return null;
    try {
      const range = document.createRange();
      range.setStart(container, 0);
      range.setEnd(node, offset);
      return range.toString().length;
    } catch {
      return null;
    }
  }

  function getTokenAtTextPosition(text, offset) {
    if (!text) return null;
    const clampedOffset = Math.max(0, Math.min(offset, text.length));
    const isTokenChar = (char) => /[A-Za-z0-9_]/.test(char);
    let index = clampedOffset;
    if (index >= text.length || !isTokenChar(text[index])) {
      if (index > 0 && isTokenChar(text[index - 1])) {
        index -= 1;
      } else {
        return null;
      }
    }
    let start = index;
    let end = index + 1;
    while (start > 0 && isTokenChar(text[start - 1])) start -= 1;
    while (end < text.length && isTokenChar(text[end])) end += 1;
    return {
      token: text.slice(start, end),
      offsetInText: start,
      offsetInToken: index - start
    };
  }

  function getBestTokenMatchOffset(lineText, token, preferredRatio, offsetInToken = 0) {
    if (!token) return null;
    const matches = [];
    let index = -1;
    while ((index = lineText.indexOf(token, index + 1)) !== -1) {
      const before = index === 0 ? '' : lineText[index - 1];
      const after = index + token.length >= lineText.length ? '' : lineText[index + token.length];
      if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
      matches.push(index);
    }
    if (!matches.length) return null;
    if (matches.length === 1) return matches[0] + Math.min(offsetInToken, token.length);
    const targetIndex = Math.max(0, Math.min(lineText.length, Math.round(lineText.length * preferredRatio)));
    let best = matches[0];
    let bestDistance = Math.abs(matches[0] - targetIndex);
    for (const matchIndex of matches.slice(1)) {
      const distance = Math.abs(matchIndex - targetIndex);
      if (distance < bestDistance) {
        best = matchIndex;
        bestDistance = distance;
      }
    }
    return best + Math.min(offsetInToken, token.length);
  }

  function getMathExpressionOffset(source, lineNumber, isBlockMath) {
    const lineStart = getLineStartOffset(source, lineNumber);
    const lineText = getLineTextAt(source, lineNumber);
    if (isBlockMath) {
      const blockIndex = lineText.indexOf('$$');
      if (blockIndex !== -1) return lineStart + blockIndex;
      return lineStart;
    }
    const inlineIndex = lineText.indexOf('$');
    if (inlineIndex !== -1) return lineStart + inlineIndex;
    return lineStart;
  }

  function getNearestInlineMathOffset(lineText, preferredRatio) {
    const matches = [];
    const regex = /\$([^\$\n]+?)\$/g;
    let match;
    while ((match = regex.exec(lineText)) !== null) matches.push(match.index);
    if (!matches.length) return null;
    if (matches.length === 1) return matches[0];
    const targetIndex = Math.max(0, Math.min(lineText.length, Math.round(lineText.length * preferredRatio)));
    let best = matches[0];
    let bestDistance = Math.abs(matches[0] - targetIndex);
    for (const matchIndex of matches.slice(1)) {
      const distance = Math.abs(matchIndex - targetIndex);
      if (distance < bestDistance) {
        best = matchIndex;
        bestDistance = distance;
      }
    }
    return best;
  }

  function revealEditorOffset(offset) {
    App.editor.revealOffset(offset);
  }

  function moveEditorCursorToPreviewClick(event) {
    if (event.target.closest('.comment-indicator, button, a')) return;
    const preview = $('#preview');
    const selection = root.getSelection();
    if (selection && !selection.isCollapsed && preview.contains(selection.anchorNode)) return;
    const lineEl = event.target.closest('[data-line]');
    if (!lineEl) return;
    const lineNumber = parseInt(lineEl.getAttribute('data-line'), 10);
    if (!lineNumber) return;
    const source = App.editor.getValue();
    const lineStart = getLineStartOffset(source, lineNumber);
    const mathBlock = event.target.closest('.math-block');
    const mathInline = event.target.closest('.math-inline');
    const renderedText = lineEl.textContent || '';
    let targetOffset = lineStart;
    if (mathBlock) {
      targetOffset = getMathExpressionOffset(source, lineNumber, true);
    } else if (mathInline) {
      const caret = getPreviewCaretAtPoint(event);
      let preferredRatio = 0;
      if (caret && caret.node && lineEl.contains(caret.node)) {
        const offsetInRenderedText = getRenderedTextOffset(lineEl, caret.node, caret.offset);
        if (offsetInRenderedText !== null && renderedText.length) {
          preferredRatio = Math.max(0, Math.min(1, offsetInRenderedText / renderedText.length));
        }
      }
      const lineText = getLineTextAt(source, lineNumber);
      const inlineMathOffset = getNearestInlineMathOffset(lineText, preferredRatio);
      targetOffset = inlineMathOffset !== null
        ? lineStart + inlineMathOffset
        : getMathExpressionOffset(source, lineNumber, false);
    } else {
      const caret = getPreviewCaretAtPoint(event);
      const caretNode = caret && caret.node && lineEl.contains(caret.node) ? caret.node : null;
      const textNode = caretNode && caretNode.nodeType === Node.TEXT_NODE ? caretNode : null;
      if (textNode) {
        const tokenInfo = getTokenAtTextPosition(textNode.textContent || '', caret.offset);
        if (tokenInfo && tokenInfo.token) {
          const lineText = getLineTextAt(source, lineNumber);
          const offsetInRenderedText = getRenderedTextOffset(lineEl, textNode, caret.offset);
          const preferredRatio = renderedText.length && offsetInRenderedText !== null
            ? Math.max(0, Math.min(1, offsetInRenderedText / renderedText.length))
            : 0;
          const matchOffset = getBestTokenMatchOffset(
            lineText,
            tokenInfo.token,
            preferredRatio,
            tokenInfo.offsetInToken
          );
          if (matchOffset !== null) targetOffset = lineStart + matchOffset;
        }
      }
    }
    App.editor.focus();
    App.editor.setCursor(targetOffset);
    revealEditorOffset(targetOffset);
  }

  function getSelectionLine(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== $('#preview')) {
      if (el.hasAttribute && el.hasAttribute('data-line')) return parseInt(el.getAttribute('data-line'), 10);
      el = el.parentElement;
    }
    return null;
  }

  function getSourceOffsetsForSlice(source, startLine, endLine, selectedText) {
    if (!selectedText || !startLine || !endLine) return null;
    const sliceStart = getLineStartOffset(source, startLine);
    const sliceEnd = getLineEndOffset(source, endLine);
    const sourceSlice = source.slice(sliceStart, sliceEnd);
    let matchIndex = sourceSlice.indexOf(selectedText);
    if (matchIndex === -1) {
      const escaped = selectedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const match = sourceSlice.match(new RegExp(escaped));
      matchIndex = match ? match.index : -1;
    }
    if (matchIndex === -1) return null;
    return {
      startOffset: sliceStart + matchIndex,
      endOffset: sliceStart + matchIndex + selectedText.length
    };
  }

  function getSourceOffsetsFromPreviewSelection(startLine, endLine, selectedText) {
    return getSourceOffsetsForSlice(App.editor.getValue(), startLine, endLine, selectedText);
  }

  function getMathElementsInRange(range) {
    const preview = $('#preview');
    if (!preview || !range || typeof range.intersectsNode !== 'function') return [];
    return [...preview.querySelectorAll('.math-inline[data-source-start], .math-block[data-source-start]')]
      .filter((element) => {
        try {
          return range.intersectsNode(element);
        } catch {
          return false;
        }
      });
  }

  function getRangeTextBeforeElement(range, element) {
    try {
      const prefix = range.cloneRange();
      prefix.setEndBefore(element);
      return prefix.toString().trim();
    } catch {
      return '';
    }
  }

  function getRangeTextAfterElement(range, element) {
    try {
      const suffix = range.cloneRange();
      suffix.setStartAfter(element);
      return suffix.toString().trim();
    } catch {
      return '';
    }
  }

  function findTextInSourceRegion(source, text, regionStart, regionEnd, preferLast = false) {
    const needle = String(text || '').trim();
    const start = Math.max(0, regionStart || 0);
    const end = Math.max(start, Math.min(source.length, regionEnd));
    if (!needle || start >= end) return null;
    const region = source.slice(start, end);
    const index = preferLast ? region.lastIndexOf(needle) : region.indexOf(needle);
    if (index !== -1) {
      return { start: start + index, end: start + index + needle.length };
    }
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const matches = [...region.matchAll(new RegExp(escaped, 'g'))];
    if (!matches.length) return null;
    const match = preferLast ? matches[matches.length - 1] : matches[0];
    return { start: start + match.index, end: start + match.index + match[0].length };
  }

  function getSourceAnchorFromPreviewRange(range, startLine, endLine, selectedText) {
    const source = App.editor.getValue();
    const mathElements = getMathElementsInRange(range);
    if (!mathElements.length) {
      const offsets = getSourceOffsetsForSlice(source, startLine, endLine, selectedText);
      return {
        startOffset: offsets ? offsets.startOffset : null,
        endOffset: offsets ? offsets.endOffset : null,
        selectedText,
        includesMath: false
      };
    }

    const firstMath = mathElements[0];
    const lastMath = mathElements[mathElements.length - 1];
    const firstMathStart = parseInt(firstMath.dataset.sourceStart, 10);
    const lastMathEnd = parseInt(lastMath.dataset.sourceEnd, 10);
    const sliceStart = getLineStartOffset(source, startLine);
    const sliceEnd = getLineEndOffset(source, endLine);
    const prefixText = firstMath.contains(range.startContainer)
      ? ''
      : getRangeTextBeforeElement(range, firstMath);
    const suffixText = lastMath.contains(range.endContainer)
      ? ''
      : getRangeTextAfterElement(range, lastMath);
    const prefixMatch = findTextInSourceRegion(source, prefixText, sliceStart, firstMathStart, true);
    const suffixMatch = findTextInSourceRegion(source, suffixText, lastMathEnd, sliceEnd, false);
    let startOffset = prefixMatch ? prefixMatch.start : firstMathStart;
    let endOffset = suffixMatch ? suffixMatch.end : lastMathEnd;
    while (startOffset < endOffset && /\s/.test(source[startOffset])) startOffset += 1;
    while (endOffset > startOffset && /\s/.test(source[endOffset - 1])) endOffset -= 1;
    return {
      startOffset,
      endOffset,
      selectedText: source.slice(startOffset, endOffset),
      includesMath: true
    };
  }

  function syncEditorToPreview() {
    if (!state.settings.syncView || state.syncingScroll) return;
    const preview = $('#preview');
    if (!preview || !preview.offsetParent) return;
    const source = App.editor.getScrollInfo();
    const targetRange = preview.scrollHeight - preview.clientHeight;
    state.syncingScroll = true;
    preview.scrollTop = targetRange > 0 ? source.ratio * targetRange : 0;
    root.requestAnimationFrame(() => {
      state.syncingScroll = false;
    });
  }

  function syncPreviewToEditor() {
    if (!state.settings.syncView || state.syncingScroll) return;
    const preview = $('#preview');
    if (!preview || !preview.offsetParent) return;
    const previewRange = preview.scrollHeight - preview.clientHeight;
    const ratio = previewRange > 0 ? preview.scrollTop / previewRange : 0;
    state.syncingScroll = true;
    App.editor.scrollToRatio(ratio);
    root.requestAnimationFrame(() => {
      state.syncingScroll = false;
    });
  }

  function updatePreview() {
    if (!state.currentFile) {
      $('#preview').innerHTML = '';
      return;
    }
    const source = App.editor.getValue();
    const parsed = root.ScientificPreview
      ? root.ScientificPreview.parseDocument(source)
      : { metadata: {}, body: source, bodyLineOffset: 0 };
    const bodySourceOffset = getLineStartOffset(source, parsed.bodyLineOffset + 1);
    const html = root.marked.parse(preprocessMath(parsed.body, parsed.bodyLineOffset, bodySourceOffset));
    const finalBodyHtml = postprocessMath(html);
    const scientific = root.ScientificPreview
      ? root.ScientificPreview.renderDocument(parsed, finalBodyHtml)
      : { headerHtml: '', bodyHtml: finalBodyHtml, referencesHtml: '' };
    const preview = $('#preview');
    preview.innerHTML = `${scientific.headerHtml}<div class="paper-body">${scientific.bodyHtml}</div>${scientific.referencesHtml}`;
    rewriteProjectImageSources(preview);
    const bodyContainer = preview.querySelector('.paper-body') || preview;
    annotateLines(bodyContainer, parsed.body, parsed.bodyLineOffset);
    renderHighlight(bodyContainer);
    if (App.comments.updateCommentMarkers) App.comments.updateCommentMarkers();
  }

  function schedulePreview() {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(updatePreview, 120);
  }

  function initPreviewClickNavigation() {
    $('#preview').addEventListener('click', (event) => {
      moveEditorCursorToPreviewClick(event);
    });
  }

  const previewApi = {
    annotateLines,
    getBestTokenMatchOffset,
    getLineEndOffset,
    getLineNumberAtOffset,
    getLineStartOffset,
    getLineTextAt,
    getNearestInlineMathOffset,
    getSelectionLine,
    getSourceAnchorFromPreviewRange,
    getSourceOffsetsForSlice,
    getSourceOffsetsFromPreviewSelection,
    getTokenAtTextPosition,
    initPreviewClickNavigation,
    moveEditorCursorToPreviewClick,
    revealEditorOffset,
    resolveProjectImageUrl,
    rewriteProjectImageSources,
    schedulePreview,
    syncEditorToPreview,
    syncPreviewToEditor,
    updatePreview
  };

  App.preview = previewApi;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      findSourceLineForRenderedText,
      findTextInSourceRegion,
      getBestTokenMatchOffset,
      getNearestInlineMathOffset,
      lineMatchesRenderedText,
      resolveProjectImageUrl,
      preprocessMath,
      getSourceOffsetsForSlice,
      getTokenAtTextPosition
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
