import difflib
import re


TOKEN_RE = re.compile(r"\w+|[^\w\s]+|\s+")


def _strip_line_endings(line):
    return line.rstrip('\n\r')


def _tokenize(line):
    return TOKEN_RE.findall(line)


def _build_segments(source_line, other_line):
    source_tokens = _tokenize(source_line)
    other_tokens = _tokenize(other_line)
    segments = []

    matcher = difflib.SequenceMatcher(None, source_tokens, other_tokens)
    for tag, i1, i2, _, _ in matcher.get_opcodes():
        text = ''.join(source_tokens[i1:i2])
        if text:
            segments.append({'text': text, 'changed': tag != 'equal'})

    return segments or [{'text': source_line, 'changed': bool(source_line)}]


def _changed_line(line_type, line_text, line_number_key, line_number, other_line=None):
    row = {
        'type': line_type,
        'line': line_text,
        line_number_key: line_number,
    }
    row['segments'] = _build_segments(line_text, other_line if other_line is not None else '')
    return row


def compute_diff(base_text, candidate_text):
    base_lines = base_text.splitlines(keepends=True)
    cand_lines = candidate_text.splitlines(keepends=True)

    matcher = difflib.SequenceMatcher(None, base_lines, cand_lines)
    diff_lines = []

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal':
            for line in base_lines[i1:i2]:
                diff_lines.append({'type': 'context', 'line': _strip_line_endings(line)})
            continue

        if tag == 'replace':
            removed_lines = [_strip_line_endings(line) for line in base_lines[i1:i2]]
            added_lines = [_strip_line_endings(line) for line in cand_lines[j1:j2]]
            paired_count = min(len(removed_lines), len(added_lines))

            for offset in range(paired_count):
                removed_line = removed_lines[offset]
                added_line = added_lines[offset]
                diff_lines.append(
                    _changed_line('removed', removed_line, 'baseLine', i1 + offset + 1, other_line=added_line)
                )
                diff_lines.append(
                    _changed_line('added', added_line, 'candLine', j1 + offset + 1, other_line=removed_line)
                )

            for offset, removed_line in enumerate(removed_lines[paired_count:], start=paired_count):
                diff_lines.append(_changed_line('removed', removed_line, 'baseLine', i1 + offset + 1))

            for offset, added_line in enumerate(added_lines[paired_count:], start=paired_count):
                diff_lines.append(_changed_line('added', added_line, 'candLine', j1 + offset + 1))
            continue

        if tag == 'delete':
            for offset, line in enumerate(base_lines[i1:i2]):
                diff_lines.append(
                    _changed_line('removed', _strip_line_endings(line), 'baseLine', i1 + offset + 1)
                )
            continue

        if tag == 'insert':
            for offset, line in enumerate(cand_lines[j1:j2]):
                diff_lines.append(
                    _changed_line('added', _strip_line_endings(line), 'candLine', j1 + offset + 1)
                )

    return diff_lines

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
