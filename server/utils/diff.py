import difflib
import re


TOKEN_RE = re.compile(r"\w+|[^\w\s]+|\s+")


def _strip_line_endings(line):
    return line.rstrip('\n\r')


def _tokenize(line):
    return TOKEN_RE.findall(line)


def _line_from_tokens(tokens):
    return ''.join(tokens)


def _segments_from_spans(tokens, changed_spans, row_id):
    segments = []
    cursor = 0
    chunk_index = 0
    for span in changed_spans:
        start = span['start']
        end = span['end']
        if cursor < start:
            segments.append({
                'text': _line_from_tokens(tokens[cursor:start]),
                'changed': False,
                'startOffset': cursor,
                'endOffset': start,
            })
        if start < end:
            segments.append({
                'text': _line_from_tokens(tokens[start:end]),
                'changed': True,
                'startOffset': start,
                'endOffset': end,
                'chunkId': f'{row_id}-chunk-{chunk_index}',
            })
            chunk_index += 1
        cursor = end
    if cursor < len(tokens):
        segments.append({
            'text': _line_from_tokens(tokens[cursor:]),
            'changed': False,
            'startOffset': cursor,
            'endOffset': len(tokens),
        })
    if not segments:
        segments.append({
            'text': '',
            'changed': False,
            'startOffset': 0,
            'endOffset': 0,
        })
    return segments


def _row(row_id, line_type, line_text, segments, extra=None):
    payload = {
        'rowId': row_id,
        'type': line_type,
        'line': line_text,
        'segments': segments,
    }
    if extra:
        payload.update(extra)
    return payload


def _build_replace_rows(base_line, cand_line, base_line_no, cand_line_no, row_index):
    base_tokens = _tokenize(base_line)
    cand_tokens = _tokenize(cand_line)
    matcher = difflib.SequenceMatcher(None, base_tokens, cand_tokens)

    base_spans = []
    cand_spans = []
    base_chunks = []
    cand_chunks = []
    chunk_counter = 0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal':
            continue
        if i1 != i2:
            base_spans.append({'start': i1, 'end': i2})
        if j1 != j2:
            cand_spans.append({'start': j1, 'end': j2})
        if i1 == i2 and j1 == j2:
            continue
        base_chunk_id = f'row-{row_index}-chunk-{chunk_counter}'
        cand_chunk_id = f'row-{row_index + 1}-chunk-{chunk_counter}'
        chunk_meta = {
            'kind': 'replace',
            'pairKey': f'pair-{row_index}-{chunk_counter}',
            'baseLine': base_line_no,
            'candLine': cand_line_no,
            'baseLineText': base_line,
            'candLineText': cand_line,
            'baseTokenStart': i1,
            'baseTokenEnd': i2,
            'candTokenStart': j1,
            'candTokenEnd': j2,
            'baseText': _line_from_tokens(base_tokens[i1:i2]),
            'candText': _line_from_tokens(cand_tokens[j1:j2]),
        }
        base_chunks.append({
            'chunkId': base_chunk_id,
            **chunk_meta,
            'pairedChunkId': cand_chunk_id,
        })
        cand_chunks.append({
            'chunkId': cand_chunk_id,
            **chunk_meta,
            'pairedChunkId': base_chunk_id,
        })
        chunk_counter += 1

    removed_row_id = f'row-{row_index}'
    added_row_id = f'row-{row_index + 1}'
    removed_segments = _segments_from_spans(base_tokens, base_spans, removed_row_id)
    added_segments = _segments_from_spans(cand_tokens, cand_spans, added_row_id)

    return [
        _row(removed_row_id, 'removed', base_line, removed_segments, {
            'baseLine': base_line_no,
            'candLine': cand_line_no,
            'pairRowId': added_row_id,
            'chunks': base_chunks,
        }),
        _row(added_row_id, 'added', cand_line, added_segments, {
            'baseLine': base_line_no,
            'candLine': cand_line_no,
            'pairRowId': removed_row_id,
            'chunks': cand_chunks,
        }),
    ]


def _build_single_line_row(line_type, line_text, line_number_key, line_number, row_index):
    row_id = f'row-{row_index}'
    tokens = _tokenize(line_text)
    changed_spans = [{'start': 0, 'end': len(tokens)}] if tokens else []
    segments = _segments_from_spans(tokens, changed_spans, row_id)
    kind = 'line-add' if line_type == 'added' else 'line-remove'
    chunk_text_key = 'candText' if line_type == 'added' else 'baseText'
    chunks = [{
        'chunkId': f'{row_id}-chunk-0',
        'kind': kind,
        line_number_key: line_number,
        chunk_text_key: line_text,
        'baseText': line_text if line_type == 'removed' else '',
        'candText': line_text if line_type == 'added' else '',
    }]
    return _row(row_id, line_type, line_text, segments, {
        line_number_key: line_number,
        'chunks': chunks,
    })


def _select_monotonic_matches(smaller, larger):
    """Map every line in smaller to the most similar ordered line in larger."""
    small_count = len(smaller)
    large_count = len(larger)
    impossible = float('-inf')
    scores = [[impossible] * (large_count + 1) for _ in range(small_count + 1)]
    take = [[False] * (large_count + 1) for _ in range(small_count + 1)]
    for large_index in range(large_count + 1):
        scores[0][large_index] = 0.0

    for small_index in range(1, small_count + 1):
        for large_index in range(1, large_count + 1):
            skip_score = scores[small_index][large_index - 1]
            match_score = scores[small_index - 1][large_index - 1]
            if match_score != impossible:
                match_score += difflib.SequenceMatcher(
                    None,
                    _tokenize(smaller[small_index - 1]),
                    _tokenize(larger[large_index - 1]),
                ).ratio()
            if match_score >= skip_score:
                scores[small_index][large_index] = match_score
                take[small_index][large_index] = True
            else:
                scores[small_index][large_index] = skip_score

    matches = {}
    small_index, large_index = small_count, large_count
    while small_index:
        if take[small_index][large_index]:
            matches[small_index - 1] = large_index - 1
            small_index -= 1
        large_index -= 1
    return matches


def compute_diff(base_text, candidate_text):
    base_lines = base_text.splitlines(keepends=True)
    cand_lines = candidate_text.splitlines(keepends=True)

    matcher = difflib.SequenceMatcher(None, base_lines, cand_lines)
    diff_lines = []
    row_index = 0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal':
            for offset, line in enumerate(base_lines[i1:i2]):
                text = _strip_line_endings(line)
                diff_lines.append(_row(
                    f'row-{row_index}',
                    'context',
                    text,
                    [{
                        'text': text,
                        'changed': False,
                        'startOffset': 0,
                        'endOffset': len(_tokenize(text)),
                    }],
                    {
                        'baseLine': i1 + offset + 1,
                        'candLine': j1 + offset + 1,
                    }
                ))
                row_index += 1
            continue

        if tag == 'replace':
            removed_lines = [_strip_line_endings(line) for line in base_lines[i1:i2]]
            added_lines = [_strip_line_endings(line) for line in cand_lines[j1:j2]]
            if len(removed_lines) == len(added_lines):
                operations = [
                    ('pair', offset, offset)
                    for offset in range(len(removed_lines))
                ]
            elif len(removed_lines) < len(added_lines):
                removed_to_added = _select_monotonic_matches(removed_lines, added_lines)
                added_to_removed = {
                    added_index: removed_index
                    for removed_index, added_index in removed_to_added.items()
                }
                operations = [
                    ('pair', added_to_removed[added_index], added_index)
                    if added_index in added_to_removed else ('add', None, added_index)
                    for added_index in range(len(added_lines))
                ]
            else:
                added_to_removed = _select_monotonic_matches(added_lines, removed_lines)
                removed_to_added = {
                    removed_index: added_index
                    for added_index, removed_index in added_to_removed.items()
                }
                operations = [
                    ('pair', removed_index, removed_to_added[removed_index])
                    if removed_index in removed_to_added else ('remove', removed_index, None)
                    for removed_index in range(len(removed_lines))
                ]

            for operation, removed_index, added_index in operations:
                if operation == 'pair':
                    diff_lines.extend(_build_replace_rows(
                        removed_lines[removed_index],
                        added_lines[added_index],
                        i1 + removed_index + 1,
                        j1 + added_index + 1,
                        row_index,
                    ))
                    row_index += 2
                elif operation == 'remove':
                    diff_lines.append(_build_single_line_row(
                        'removed', removed_lines[removed_index], 'baseLine',
                        i1 + removed_index + 1, row_index,
                    ))
                    row_index += 1
                else:
                    diff_lines.append(_build_single_line_row(
                        'added', added_lines[added_index], 'candLine',
                        j1 + added_index + 1, row_index,
                    ))
                    row_index += 1
            continue

        if tag == 'delete':
            for offset, line in enumerate(base_lines[i1:i2]):
                diff_lines.append(_build_single_line_row('removed', _strip_line_endings(line), 'baseLine', i1 + offset + 1, row_index))
                row_index += 1
            continue

        if tag == 'insert':
            for offset, line in enumerate(cand_lines[j1:j2]):
                diff_lines.append(_build_single_line_row('added', _strip_line_endings(line), 'candLine', j1 + offset + 1, row_index))
                row_index += 1

    return diff_lines


def _find_chunk(diff_rows, row_id, chunk_id):
    for index, row in enumerate(diff_rows):
        if row.get('rowId') != row_id:
            continue
        for chunk in row.get('chunks', []):
            if chunk.get('chunkId') == chunk_id:
                return row, chunk, index
    return None, None, None


def _sort_chunk_decisions(decisions):
    def parse_index(value, prefix):
        try:
            return int(str(value).split(prefix, 1)[1])
        except Exception:
            return 0

    return sorted(
        decisions,
        key=lambda item: (
            parse_index(item.get('rowId', ''), 'row-'),
            parse_index(item.get('chunkId', ''), '-chunk-'),
        )
    )


def _line_endings(text):
    endings = text.splitlines(keepends=True)
    if endings:
        return [line[len(_strip_line_endings(line)):] for line in endings]
    return []


def _score_line_match(source_line, current_line, line_index=None, preferred_index=None, window=4):
    score = difflib.SequenceMatcher(None, source_line, current_line).ratio()
    if line_index is not None and preferred_index is not None:
        distance = abs(line_index - preferred_index)
        score -= min(distance, window) * 0.02
    return score


def _context_matches(lines, preferred_index, prev_context, next_context):
    prev_ok = True
    next_ok = True
    if prev_context:
        start = preferred_index - len(prev_context)
        if start < 0:
            prev_ok = False
        else:
            prev_ok = all(
                difflib.SequenceMatcher(None, actual, expected).ratio() >= 0.45
                for actual, expected in zip(lines[start:preferred_index], prev_context)
            )
    if next_context:
        end = preferred_index + 1 + len(next_context)
        if end > len(lines):
            next_ok = False
        else:
            next_ok = all(
                difflib.SequenceMatcher(None, actual, expected).ratio() >= 0.45
                for actual, expected in zip(lines[preferred_index + 1:end], next_context)
            )
    return (prev_context and prev_ok) or (next_context and next_ok) or (prev_context and next_context and prev_ok and next_ok)


def _find_best_line_index(lines, source_line, preferred_line_number=None, alternate_line=None, prev_context=None, next_context=None):
    if not lines:
        return None
    candidates = []
    preferred_index = preferred_line_number - 1 if preferred_line_number else None
    line_indexes = range(len(lines))
    if preferred_index is not None:
        nearby = [idx for idx in line_indexes if abs(idx - preferred_index) <= 4]
        far = [idx for idx in line_indexes if abs(idx - preferred_index) > 4]
        ordered_indexes = nearby + far
    else:
        ordered_indexes = list(line_indexes)

    for idx in ordered_indexes:
        score = _score_line_match(source_line, lines[idx], line_index=idx, preferred_index=preferred_index)
        if alternate_line is not None:
            score = max(score, _score_line_match(alternate_line, lines[idx], line_index=idx, preferred_index=preferred_index))
        candidates.append((score, idx))
    candidates.sort(reverse=True)
    best_score, best_index = candidates[0]
    if best_score < 0.45:
        if preferred_index is not None:
            fallback_index = max(0, min(preferred_index, len(lines) - 1))
            if _context_matches(lines, fallback_index, prev_context or [], next_context or []):
                return fallback_index
        return None
    return best_index


def _get_row_context(diff_rows, row_index):
    prev_context = []
    idx = row_index - 1
    while idx >= 0 and len(prev_context) < 2:
        if diff_rows[idx].get('type') == 'context':
            prev_context.insert(0, diff_rows[idx].get('line', ''))
        idx -= 1

    next_context = []
    idx = row_index + 1
    while idx < len(diff_rows) and len(next_context) < 2:
        if diff_rows[idx].get('type') == 'context':
            next_context.append(diff_rows[idx].get('line', ''))
        idx += 1
    return prev_context, next_context


def _map_span_to_current(source_tokens, current_tokens, start_token, end_token):
    if start_token == end_token:
        matcher = difflib.SequenceMatcher(None, source_tokens, current_tokens)
        candidate_indexes = []
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if start_token < i1:
                break
            if i1 <= start_token <= i2:
                if tag == 'equal':
                    candidate_indexes.append(j1 + (start_token - i1))
                else:
                    candidate_indexes.append(j1)
            if start_token == i2:
                candidate_indexes.append(j2)
        if candidate_indexes:
            point = min(candidate_indexes)
            return point, point
        return None

    matcher = difflib.SequenceMatcher(None, source_tokens, current_tokens)
    current_indexes = []
    matched_indexes = []

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        overlap_start = max(start_token, i1)
        overlap_end = min(end_token, i2)
        if overlap_start >= overlap_end:
            continue
        matched_indexes.extend(range(overlap_start, overlap_end))
        if tag == 'delete':
            continue
        if tag == 'equal':
            current_indexes.extend(range(j1 + (overlap_start - i1), j1 + (overlap_end - i1)))
            continue
        span_len = i2 - i1
        mapped_len = j2 - j1
        rel_start = overlap_start - i1
        rel_end = overlap_end - i1
        current_start = j1 + round((rel_start / span_len) * mapped_len) if span_len else j1
        current_end = j1 + round((rel_end / span_len) * mapped_len) if span_len else j2
        current_indexes.extend(range(current_start, current_end))

    if not matched_indexes or not current_indexes:
        return None
    return min(current_indexes), max(current_indexes) + 1


def _replace_tokens_in_line(current_line, source_line, source_span, target_text):
    source_tokens = _tokenize(source_line)
    current_tokens = _tokenize(current_line)
    mapped_span = _map_span_to_current(source_tokens, current_tokens, source_span[0], source_span[1])
    if mapped_span is None:
        return None
    current_start, current_end = mapped_span
    replacement_tokens = _tokenize(target_text)
    replaced_tokens = current_tokens[:current_start] + replacement_tokens + current_tokens[current_end:]
    return _line_from_tokens(replaced_tokens)


def _chunk_already_in_line(current_line, target_line, target_span):
    if target_span[0] == target_span[1]:
        return current_line == target_line
    target_tokens = _tokenize(target_line)
    current_tokens = _tokenize(current_line)
    mapped_span = _map_span_to_current(target_tokens, current_tokens, target_span[0], target_span[1])
    if mapped_span is None:
        return False
    current_start, current_end = mapped_span
    current_text = _line_from_tokens(current_tokens[current_start:current_end])
    target_text = _line_from_tokens(target_tokens[target_span[0]:target_span[1]])
    return current_text == target_text


def _find_exact_line(lines, text, preferred_line_number=None):
    if preferred_line_number:
        preferred_index = preferred_line_number - 1
        if 0 <= preferred_index < len(lines) and lines[preferred_index] == text:
            return preferred_index
        for delta in range(1, 5):
            for index in (preferred_index - delta, preferred_index + delta):
                if 0 <= index < len(lines) and lines[index] == text:
                    return index
    for index, line in enumerate(lines):
        if line == text:
            return index
    return None


def _is_whole_line_chunk(chunk):
    return (
        chunk.get('baseTokenStart', 0) == 0
        and chunk.get('candTokenStart', 0) == 0
        and chunk.get('baseTokenEnd', 0) == len(_tokenize(chunk.get('baseLineText', '')))
        and chunk.get('candTokenEnd', 0) == len(_tokenize(chunk.get('candLineText', '')))
    )


def _insert_line(lines, endings, index, text):
    insert_index = max(0, min(index, len(lines)))
    lines.insert(insert_index, text)
    endings.insert(insert_index, '\n' if lines and any(ending == '\n' for ending in endings) else '\n')


def _apply_replace_chunk(current_content, chunk, decision, row, prev_context=None, next_context=None):
    source_line = chunk['baseLineText'] if decision == 'accept' else chunk['candLineText']
    target_text = chunk['candText'] if decision == 'accept' else chunk['baseText']
    target_line = chunk['candLineText'] if decision == 'accept' else chunk['baseLineText']
    source_span = (
        chunk['baseTokenStart'],
        chunk['baseTokenEnd'],
    ) if decision == 'accept' else (
        chunk['candTokenStart'],
        chunk['candTokenEnd'],
    )
    target_span = (
        chunk['candTokenStart'],
        chunk['candTokenEnd'],
    ) if decision == 'accept' else (
        chunk['baseTokenStart'],
        chunk['baseTokenEnd'],
    )
    target_chunk_text = chunk['baseText'] if decision == 'accept' else chunk['candText']
    preferred_line = row.get('baseLine') if decision == 'accept' else row.get('candLine')

    lines = current_content.splitlines(keepends=False)
    endings = _line_endings(current_content)
    if not lines and current_content == '':
        lines = ['']
        endings = ['']
    if _is_whole_line_chunk(chunk):
        exact_target = _find_exact_line(lines, target_line, preferred_line)
        if exact_target is not None:
            return current_content
    line_index = _find_best_line_index(
        lines,
        source_line,
        preferred_line_number=preferred_line,
        alternate_line=target_line,
        prev_context=prev_context,
        next_context=next_context,
    )
    if line_index is None:
        return None

    candidate_line = lines[line_index]
    if candidate_line == target_line:
        return current_content
    if _chunk_already_in_line(candidate_line, target_line, target_span):
        return current_content
    updated_line = _replace_tokens_in_line(candidate_line, source_line, source_span, target_text)
    if updated_line is None:
        if target_chunk_text and target_chunk_text in candidate_line:
            return current_content
        return None

    if updated_line == candidate_line:
        if target_text and target_text in candidate_line:
            return current_content
        return None

    lines[line_index] = updated_line
    return ''.join(f'{line}{endings[idx] if idx < len(endings) else ""}' for idx, line in enumerate(lines))


def _apply_line_chunk(current_content, chunk, decision, row):
    lines = current_content.splitlines(keepends=False)
    endings = _line_endings(current_content)

    kind = chunk['kind']
    if kind == 'line-add':
        target_present = _find_exact_line(lines, chunk['candText'], row.get('candLine'))
        if decision == 'accept':
            if target_present is not None:
                return current_content
            insert_index = (row.get('candLine') or (len(lines) + 1)) - 1
            _insert_line(lines, endings, insert_index, chunk['candText'])
            return ''.join(f'{line}{endings[idx] if idx < len(endings) else ""}' for idx, line in enumerate(lines))
        if target_present is None:
            return current_content
        del lines[target_present]
        if target_present < len(endings):
            del endings[target_present]
        return ''.join(f'{line}{endings[idx] if idx < len(endings) else ""}' for idx, line in enumerate(lines))

    target_present = _find_exact_line(lines, chunk['baseText'], row.get('baseLine'))
    if decision == 'accept':
        if target_present is None:
            return current_content
        del lines[target_present]
        if target_present < len(endings):
            del endings[target_present]
        return ''.join(f'{line}{endings[idx] if idx < len(endings) else ""}' for idx, line in enumerate(lines))

    if target_present is not None:
        return current_content
    insert_index = (row.get('baseLine') or (len(lines) + 1)) - 1
    _insert_line(lines, endings, insert_index, chunk['baseText'])
    return ''.join(f'{line}{endings[idx] if idx < len(endings) else ""}' for idx, line in enumerate(lines))


def apply_diff_chunk(base_text, candidate_text, current_content, row_id, chunk_id, decision):
    if decision not in {'accept', 'refuse'}:
        raise ValueError('decision must be accept or refuse')

    diff_rows = compute_diff(base_text, candidate_text)
    row, chunk, row_index = _find_chunk(diff_rows, row_id, chunk_id)
    if not row or not chunk:
        raise KeyError('Diff chunk not found')
    prev_context, next_context = _get_row_context(diff_rows, row_index)

    if chunk['kind'] == 'replace':
        updated = _apply_replace_chunk(current_content, chunk, decision, row, prev_context=prev_context, next_context=next_context)
    else:
        updated = _apply_line_chunk(current_content, chunk, decision, row)

    if updated is None:
        raise RuntimeError('Current content no longer matches this diff chunk')

    return {
        'content': updated,
        'row': row,
        'chunk': chunk,
        'diff': diff_rows,
    }


def apply_diff_decisions(base_text, candidate_text, original_content, decisions):
    content = original_content
    diff_rows = compute_diff(base_text, candidate_text)
    for item in _sort_chunk_decisions(decisions):
        row_id = item.get('rowId')
        chunk_id = item.get('chunkId')
        decision = item.get('decision')
        if not row_id or not chunk_id or decision not in {'accept', 'refuse'}:
            raise ValueError('Each decision requires rowId, chunkId, and decision')
        row, chunk, row_index = _find_chunk(diff_rows, row_id, chunk_id)
        if not row or not chunk:
            raise KeyError(f'Diff chunk not found: {row_id}/{chunk_id}')
        prev_context, next_context = _get_row_context(diff_rows, row_index)
        if chunk['kind'] == 'replace':
            updated = _apply_replace_chunk(content, chunk, decision, row, prev_context=prev_context, next_context=next_context)
        else:
            updated = _apply_line_chunk(content, chunk, decision, row)
        if updated is None:
            raise RuntimeError(f'Current content no longer matches diff chunk {row_id}/{chunk_id}')
        content = updated

    return {
        'content': content,
        'diff': diff_rows,
    }


def compute_diff_unified(base_text, candidate_text):
    return '\n'.join(
        difflib.unified_diff(
            base_text.splitlines(keepends=True),
            candidate_text.splitlines(keepends=True),
            fromfile='base',
            tofile='candidate',
            lineterm=''
        )
    )
