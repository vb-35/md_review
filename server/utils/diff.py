import difflib
import json

def compute_diff(base_text, candidate_text):
    base_lines = base_text.splitlines(keepends=True)
    cand_lines = candidate_text.splitlines(keepends=True)

    matcher = difflib.SequenceMatcher(None, base_lines, cand_lines)
    ops = matcher.get_opcodes()

    hunks = []
    diff_lines = []

    for tag, i1, i2, j1, j2 in ops:
        if tag == 'equal':
            for line in base_lines[i1:i2]:
                diff_lines.append({'type': 'context', 'line': line.rstrip('\n\r')})
        elif tag == 'replace':
            removed = []
            added = []
            sub_base = base_lines[i1:i2]
            sub_cand = cand_lines[j1:j2]
            sub_matcher = difflib.SequenceMatcher(None, sub_base, sub_cand)
            for st, si1, si2, sj1, sj2 in sub_matcher.get_opcodes():
                if st == 'equal':
                    for line in sub_base[si1:si2]:
                        diff_lines.append({'type': 'context', 'line': line.rstrip('\n\r')})
                elif st == 'replace':
                    for line in sub_base[si1:si2]:
                        r = line.rstrip('\n\r')
                        removed.append(r)
                        diff_lines.append({'type': 'removed', 'line': r, 'baseLine': i1 + si1 + 1})
                    for line in sub_cand[sj1:sj2]:
                        a = line.rstrip('\n\r')
                        added.append(a)
                        diff_lines.append({'type': 'added', 'line': a, 'candLine': j1 + sj1 + 1})
                elif st == 'delete':
                    for line in sub_base[si1:si2]:
                        r = line.rstrip('\n\r')
                        removed.append(r)
                        diff_lines.append({'type': 'removed', 'line': r, 'baseLine': i1 + si1 + 1})
                elif st == 'insert':
                    for line in sub_cand[sj1:sj2]:
                        a = line.rstrip('\n\r')
                        added.append(a)
                        diff_lines.append({'type': 'added', 'line': a, 'candLine': j1 + sj1 + 1})
        elif tag == 'delete':
            for line in base_lines[i1:i2]:
                r = line.rstrip('\n\r')
                diff_lines.append({'type': 'removed', 'line': r, 'baseLine': i1 + 1})
        elif tag == 'insert':
            for line in cand_lines[j1:j2]:
                a = line.rstrip('\n\r')
                diff_lines.append({'type': 'added', 'line': a, 'candLine': j1 + 1})

    return json.dumps(diff_lines)

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
