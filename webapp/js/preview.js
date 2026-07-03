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

  function preprocessMath(md, lineOffset = 0) {
    const source = md;
    state.mathPlaceholders = {};
    state.placeholderCounter = 0;

    md = md.replace(/\$\$([\s\S]+?)\$\$/g, (match, math, offset) => {
      const key = `{MATHB:${state.placeholderCounter++}}`;
      state.mathPlaceholders[key] = {
        type: 'block',
        math: math.trim(),
        line: lineOffset + getLineNumberAtOffset(source, offset)
      };
      return `\n\n${key}\n\n`;
    });

    md = md.replace(/\$([^\$\n]+?)\$/g, (match, math, offset) => {
      const key = `{MATHI:${state.placeholderCounter++}}`;
      state.mathPlaceholders[key] = {
        type: 'inline',
        math,
        line: lineOffset + getLineNumberAtOffset(source, offset)
      };
      return ` ${key} `;
    });

    return md;
  }

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function postprocessMath(html) {
    for (const [key, { type, math, line }] of Object.entries(state.mathPlaceholders)) {
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
      const wrapper = type === 'block'
        ? `<div class="math-block"${lineAttr}>${rendered}</div>`
        : `<span class="math-inline"${lineAttr}>${rendered}</span>`;
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

  function annotateLines(container, source, lineOffset = 0) {
    const lines = source.split('\n');
    const blockEls = container.querySelectorAll('h1, h2, h3, h4, h5, h6, p, pre, blockquote, li, td, tr, table, ul, ol, div.math-block, hr');
    const processed = new Set();

    for (const el of blockEls) {
      if (processed.has(el)) continue;
      if (el.hasAttribute('data-line')) {
        processed.add(el);
        continue;
      }
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let textNode;
      let lineNumber = null;
      while ((textNode = walker.nextNode())) {
        const content = textNode.textContent.trim();
        if (!content) continue;
        const searchText = content.substring(0, 50);
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].includes(searchText)) {
            lineNumber = lineOffset + i + 1;
            break;
          }
        }
        break;
      }
      if (lineNumber) el.setAttribute('data-line', lineNumber);
      processed.add(el);
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
    const editor = $('#editor');
    const lineHeight = parseFloat(root.getComputedStyle(editor).lineHeight) || 22;
    const lineIndex = editor.value.slice(0, offset).split('\n').length - 1;
    const top = lineIndex * lineHeight;
    const bottom = top + lineHeight;
    if (top < editor.scrollTop) {
      editor.scrollTop = top;
    } else if (bottom > editor.scrollTop + editor.clientHeight) {
      editor.scrollTop = bottom - editor.clientHeight;
    }
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
    const source = $('#editor').value || '';
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
    const editor = $('#editor');
    editor.focus();
    editor.setSelectionRange(targetOffset, targetOffset);
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
    return getSourceOffsetsForSlice($('#editor').value || '', startLine, endLine, selectedText);
  }

  function syncScroll(source, target) {
    if (!state.settings.syncView || state.syncingScroll) return;
    if (!source.offsetParent || !target.offsetParent) return;
    const sourceRange = source.scrollHeight - source.clientHeight;
    const targetRange = target.scrollHeight - target.clientHeight;
    const ratio = sourceRange > 0 ? source.scrollTop / sourceRange : 0;
    state.syncingScroll = true;
    target.scrollTop = targetRange > 0 ? ratio * targetRange : 0;
    root.requestAnimationFrame(() => {
      state.syncingScroll = false;
    });
  }

  function updatePreview() {
    if (!state.currentFile) {
      $('#preview').innerHTML = '';
      return;
    }
    const source = $('#editor').value || '';
    const parsed = root.ScientificPreview
      ? root.ScientificPreview.parseDocument(source)
      : { metadata: {}, body: source, bodyLineOffset: 0 };
    const html = root.marked.parse(preprocessMath(parsed.body, parsed.bodyLineOffset));
    const finalBodyHtml = postprocessMath(html);
    const scientific = root.ScientificPreview
      ? root.ScientificPreview.renderDocument(parsed, finalBodyHtml)
      : { headerHtml: '', bodyHtml: finalBodyHtml, referencesHtml: '' };
    const preview = $('#preview');
    preview.innerHTML = `${scientific.headerHtml}<div class="paper-body">${scientific.bodyHtml}</div>${scientific.referencesHtml}`;
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
    getSourceOffsetsForSlice,
    getSourceOffsetsFromPreviewSelection,
    getTokenAtTextPosition,
    initPreviewClickNavigation,
    moveEditorCursorToPreviewClick,
    revealEditorOffset,
    schedulePreview,
    syncScroll,
    updatePreview
  };

  App.preview = previewApi;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      getBestTokenMatchOffset,
      getNearestInlineMathOffset,
      getSourceOffsetsForSlice,
      getTokenAtTextPosition
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
