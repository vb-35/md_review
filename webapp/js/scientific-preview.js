(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.ScientificPreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function splitInlineItems(text) {
    const items = [];
    let current = '';
    let quote = null;
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quote) {
        current += char;
        if (char === quote && text[i - 1] !== '\\') quote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        current += char;
        continue;
      }
      if (char === '[') depth += 1;
      if (char === ']') depth = Math.max(0, depth - 1);
      if (char === ',' && depth === 0) {
        items.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    if (current.trim()) items.push(current.trim());
    return items;
  }

  function parseScalar(raw) {
    const value = raw.trim();
    if (!value) return '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      if (!inner) return [];
      return splitInlineItems(inner).map(parseScalar);
    }
    return value;
  }

  function parseYaml(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let index = 0;

    function getIndent(line) {
      return line.length - line.trimStart().length;
    }

    function nextMeaningful(from = index) {
      let cursor = from;
      while (cursor < lines.length) {
        const trimmed = lines[cursor].trim();
        if (trimmed && !trimmed.startsWith('#')) {
          return { index: cursor, indent: getIndent(lines[cursor]), line: lines[cursor] };
        }
        cursor += 1;
      }
      return null;
    }

    function consumeBlanks() {
      while (index < lines.length) {
        const trimmed = lines[index].trim();
        if (trimmed && !trimmed.startsWith('#')) break;
        index += 1;
      }
    }

    function parseBlock(indent) {
      consumeBlanks();
      const next = nextMeaningful(index);
      if (!next || next.indent < indent) return null;
      if (next.line.slice(next.indent).startsWith('- ')) return parseSequence(indent);
      return parseMap(indent, {});
    }

    function parseMap(indent, seed) {
      const obj = seed || {};
      while (index < lines.length) {
        consumeBlanks();
        if (index >= lines.length) break;
        const line = lines[index];
        const currentIndent = getIndent(line);
        const trimmed = line.trim();
        if (currentIndent < indent) break;
        if (currentIndent > indent) {
          index += 1;
          continue;
        }
        if (trimmed.startsWith('- ')) break;
        const match = line.slice(indent).match(/^([^:]+):(.*)$/);
        if (!match) {
          index += 1;
          continue;
        }
        const key = match[1].trim();
        const rest = match[2].trim();
        index += 1;
        if (rest) {
          obj[key] = parseScalar(rest);
          continue;
        }
        const next = nextMeaningful(index);
        obj[key] = next && next.indent > currentIndent ? parseBlock(next.indent) : null;
      }
      return obj;
    }

    function parseSequence(indent) {
      const items = [];
      while (index < lines.length) {
        consumeBlanks();
        if (index >= lines.length) break;
        const line = lines[index];
        const currentIndent = getIndent(line);
        if (currentIndent < indent) break;
        if (currentIndent !== indent || !line.slice(indent).startsWith('- ')) break;
        const rest = line.slice(indent + 2).trim();
        index += 1;
        if (!rest) {
          const next = nextMeaningful(index);
          items.push(next && next.indent > currentIndent ? parseBlock(next.indent) : null);
          continue;
        }
        const pair = rest.match(/^([^:]+):(.*)$/);
        if (pair) {
          const item = {};
          const key = pair[1].trim();
          const value = pair[2].trim();
          if (value) {
            item[key] = parseScalar(value);
          } else {
            const next = nextMeaningful(index);
            item[key] = next && next.indent > currentIndent ? parseBlock(next.indent + (next.indent === currentIndent ? 2 : 0)) : null;
          }
          items.push(parseMap(indent + 2, item));
          continue;
        }
        items.push(parseScalar(rest));
      }
      return items;
    }

    return parseBlock(0) || {};
  }

  function extractFrontmatter(source) {
    const normalized = String(source || '').replace(/\r\n/g, '\n');
    if (!normalized.startsWith('---\n') && normalized.trim() !== '---') {
      return { metadata: {}, body: normalized, bodyLineOffset: 0 };
    }
    const lines = normalized.split('\n');
    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed === '---' || trimmed === '...') {
        end = i;
        break;
      }
    }
    if (end === -1) {
      return { metadata: {}, body: normalized, bodyLineOffset: 0 };
    }
    const yamlText = lines.slice(1, end).join('\n');
    const body = lines.slice(end + 1).join('\n');
    return {
      metadata: parseYaml(yamlText) || {},
      body,
      bodyLineOffset: end + 1
    };
  }

  function parseDocument(source) {
    return extractFrontmatter(source);
  }

  function normalizeDoi(value) {
    return String(value || '')
      .trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
      .toLowerCase();
  }

  function getYear(reference) {
    const issued = reference && reference.issued;
    const parts = issued && issued['date-parts'];
    const year = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : null;
    return year ? String(year) : 'n.d.';
  }

  function getReferenceAuthors(reference) {
    const authors = Array.isArray(reference && reference.author) ? reference.author : [];
    return authors
      .map((author) => {
        if (author.literal) return String(author.literal);
        if (author.family) return String(author.family);
        if (author.name) return String(author.name);
        return '';
      })
      .filter(Boolean);
  }

  function formatReferenceAuthors(reference) {
    const authors = Array.isArray(reference && reference.author) ? reference.author : [];
    if (!authors.length) return '';
    return authors
      .map((author) => {
        if (author.literal) return escapeHtml(author.literal);
        if (author.family && author.given) return `${escapeHtml(author.family)}, ${escapeHtml(author.given)}`;
        if (author.family) return escapeHtml(author.family);
        if (author.name) return escapeHtml(author.name);
        return '';
      })
      .filter(Boolean)
      .join('; ');
  }

  function buildReferenceIndex(references) {
    const map = new Map();
    (Array.isArray(references) ? references : []).forEach((reference, index) => {
      if (!reference || typeof reference !== 'object') return;
      const normalized = { ...reference };
      if (normalized.DOI && !normalized.doi) normalized.doi = normalized.DOI;
      normalized._declaredIndex = index;
      if (normalized.id) map.set(String(normalized.id).toLowerCase(), normalized);
      if (normalized.doi) {
        const normalizedDoi = normalizeDoi(normalized.doi);
        map.set(`doi:${normalizedDoi}`, normalized);
        if (!normalized.id) map.set(normalizedDoi, normalized);
      }
    });
    return map;
  }

  function resolveReference(referenceMap, key) {
    if (!key) return null;
    const normalizedKey = String(key).trim().toLowerCase();
    if (referenceMap.has(normalizedKey)) return referenceMap.get(normalizedKey);
    if (normalizedKey.startsWith('doi:')) {
      return referenceMap.get(`doi:${normalizeDoi(normalizedKey.slice(4))}`) || null;
    }
    return referenceMap.get(`doi:${normalizeDoi(normalizedKey)}`) || null;
  }

  function splitCitationCluster(content) {
    return content.split(/\s*;\s*/).map((part) => part.trim()).filter(Boolean);
  }

  function parseCitationItem(part) {
    const match = part.match(/^(-)?@([^,\s]+(?:\/[^,\s]+)*)(?:,\s*(.+))?$/);
    if (!match) return null;
    return {
      suppressAuthor: !!match[1],
      key: match[2],
      locator: match[3] ? match[3].trim() : ''
    };
  }

  function createRenderContext(references) {
    const referenceMap = buildReferenceIndex(references);
    const ordered = [];

    function register(reference) {
      if (!reference) return null;
      const refKey = String(reference.id || reference.doi || reference.DOI || '').toLowerCase();
      if (!refKey) return null;
      if (!ordered.some((entry) => String(entry.id || entry.doi || entry.DOI || '').toLowerCase() === refKey)) {
        ordered.push(reference);
      }
      return reference;
    }

    return {
      referenceMap,
      ordered,
      register
    };
  }

  function renderDoiLink(reference, context) {
    const doiValue = normalizeDoi(reference && (reference.doi || reference.DOI || ''));
    if (!doiValue) return '';
    context.register(reference);
    return `<a class="citation" href="https://doi.org/${escapeHtml(doiValue)}" target="_blank" rel="noreferrer">${escapeHtml(doiValue)}</a>`;
  }

  function renderParentheticalCitation(items, context) {
    return items.map((item) => {
      const reference = resolveReference(context.referenceMap, item.key);
      return renderDoiLink(reference, context);
    }).filter(Boolean).join(' ');
  }

  function renderNarrativeCitation(key, context) {
    const reference = resolveReference(context.referenceMap, key);
    return renderDoiLink(reference, context);
  }

  function processTextSegment(text, context) {
    let output = text.replace(/\[([^\]]*@[^[]*?)\]/g, (match, content) => {
      const parts = splitCitationCluster(content);
      const items = parts.map(parseCitationItem);
      if (!items.every(Boolean)) return match;
      return renderParentheticalCitation(items, context);
    });

    output = output.replace(/(^|[^A-Za-z0-9_])@([A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*)/g, (match, prefix, key) => {
      return `${prefix}${renderNarrativeCitation(key, context)}`;
    });
    return output;
  }

  function replaceTextSegments(html, context) {
    return String(html || '')
      .split(/(<[^>]+>)/g)
      .map((segment) => (segment.startsWith('<') ? segment : processTextSegment(segment, context)))
      .join('');
  }

  function renderReferenceEntry(reference) {
    const doiValue = normalizeDoi(reference.doi || reference.DOI || '');
    if (!doiValue) return '';
    const authors = formatReferenceAuthors(reference);
    const year = escapeHtml(getYear(reference));
    const title = escapeHtml(reference.title || reference.id || reference.doi || 'Untitled');
    const container = escapeHtml(reference['container-title'] || '');
    const parts = [];
    if (authors) parts.push(authors);
    parts.push(`(${year})`);
    parts.push(title);
    if (container) parts.push(`<em>${container}</em>`);
    parts.push(`<a href="https://doi.org/${escapeHtml(doiValue)}" target="_blank" rel="noreferrer">${escapeHtml(doiValue)}</a>`);
    return `<li class="reference-entry">${parts.join('. ')}.</li>`;
  }

  function renderReferences(context) {
    if (!context.ordered.length) return '';
    const items = context.ordered.map((reference) => renderReferenceEntry(reference)).filter(Boolean).join('');
    if (!items) return '';
    return `<section class="paper-references"><h2>References</h2><ol class="references-list">${items}</ol></section>`;
  }

  function renderPaperHeader(metadata) {
    const title = metadata && metadata.title ? String(metadata.title) : '';
    const authors = Array.isArray(metadata && metadata.authors) ? metadata.authors : [];
    const affiliations = Array.isArray(metadata && metadata.affiliations) ? metadata.affiliations : [];
    if (!title && !authors.length && !affiliations.length) return '';

    const affiliationIndex = new Map();
    affiliations.forEach((affiliation, index) => {
      if (affiliation && affiliation.id) affiliationIndex.set(String(affiliation.id), index + 1);
    });

    const authorHtml = authors.map((author) => {
      const markers = []
        .concat(Array.isArray(author.affiliations) ? author.affiliations : [])
        .map((id) => affiliationIndex.get(String(id)))
        .filter(Boolean);
      const superscript = [];
      if (markers.length) superscript.push(markers.join(','));
      if (author.corresponding) superscript.push('*');
      const label = superscript.length ? `<sup>${escapeHtml(superscript.join(','))}</sup>` : '';
      return `<span class="paper-author">${escapeHtml(author.name || author.id || 'Unknown')}${label}</span>`;
    }).join(', ');

    const affiliationHtml = affiliations.map((affiliation, index) => {
      const parts = [affiliation.department, affiliation.name, affiliation.city, affiliation.country]
        .filter(Boolean)
        .map((part) => escapeHtml(part));
      return `<li><sup>${index + 1}</sup> ${parts.join(', ')}</li>`;
    }).join('');

    const corresponding = authors.filter((author) => author && author.corresponding);
    const correspondingHtml = corresponding.length
      ? `<div class="paper-corresponding">* Corresponding: ${corresponding.map((author) => {
        const details = [author.name, author.email, author.orcid].filter(Boolean).map(escapeHtml);
        return details.join(' · ');
      }).join('; ')}</div>`
      : '';

    return `
      <section class="paper-header">
        ${title ? `<h1 class="paper-title">${escapeHtml(title)}</h1>` : ''}
        ${authorHtml ? `<div class="paper-authors">${authorHtml}</div>` : ''}
        ${affiliationHtml ? `<ol class="paper-affiliations">${affiliationHtml}</ol>` : ''}
        ${correspondingHtml}
      </section>
    `;
  }

  function renderDocument(parsed, bodyHtml) {
    const metadata = (parsed && parsed.metadata) || {};
    const references = Array.isArray(metadata.references) ? metadata.references : [];
    const context = createRenderContext(references);
    const renderedBodyHtml = replaceTextSegments(bodyHtml, context);
    return {
      headerHtml: renderPaperHeader(metadata),
      bodyHtml: renderedBodyHtml,
      referencesHtml: renderReferences(context)
    };
  }

  return {
    extractFrontmatter,
    parseDocument,
    parseYaml,
    renderDocument
  };
});
