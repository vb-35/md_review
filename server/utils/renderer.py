import re
import html as html_module

def markdown_to_html(md_text):
    lines = md_text.split('\n')
    result = []
    i = 0
    in_code = False
    code_lang = ''
    code_block = []
    in_table = False
    table_rows = []
    in_list = False
    list_items = []

    def is_table_separator(text):
        stripped = text.strip()
        if not stripped.startswith('|'):
            return False
        cells = [cell.strip() for cell in stripped.strip('|').split('|')]
        return bool(cells) and all(cell and set(cell) <= set('-:') for cell in cells)

    def flush_list():
        nonlocal in_list, list_items
        if in_list:
            is_ordered = list_items[0].startswith('1:') if list_items else False
            tag = 'ol' if is_ordered else 'ul'
            result.append(f'<{tag}>')
            for it in list_items:
                content = it[2:] if it.startswith('- ') or it.startswith('1:') else it
                result.append(f'  <li>{_inline(content)}</li>')
            result.append(f'</{tag}>')
            in_list = False
            list_items = []

    def flush_table():
        nonlocal in_table, table_rows
        if in_table and len(table_rows) > 0:
            result.append('<table>')
            result.append('  <thead><tr>')
            for cell in table_rows[0]:
                result.append(f'    <th>{_inline(cell.strip())}</th>')
            result.append('  </tr></thead>')
            if len(table_rows) > 1:
                result.append('  <tbody>')
                for row in table_rows[1:]:
                    result.append('  <tr>')
                    for cell in row:
                        result.append(f'    <td>{_inline(cell.strip())}</td>')
                    result.append('  </tr>')
                result.append('  </tbody>')
            result.append('</table>')
        in_table = False
        table_rows = []

    def _inline(text):
        text = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        text = re.sub(r'```(.+?)```', r'<code>\1</code>', text)
        text = re.sub(r'`(.+?)`', r'<code>\1</code>', text)
        text = re.sub(r'\$\$(.+?)\$\$', r'<span class="math-block">\1</span>', text)
        text = re.sub(r'\$([^\$\n]+?)\$', r'<span class="math-inline">\1</span>', text)
        text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
        text = re.sub(r'\*(.+?)\*', r'<em>\1</em>', text)
        text = re.sub(r'\[(.+?)\]\((.+?)\)', r'<a href="\2">\1</a>', text)
        return text

    while i < len(lines):
        line = lines[i]

        if line.startswith('```'):
            if in_code:
                result.append(f'<pre><code class="language-{code_lang}">{html_module.escape("\n".join(code_block))}</code></pre>')
                in_code = False
                code_block = []
            else:
                flush_table()
                flush_list()
                in_code = True
                code_lang = line[3:].strip()
            i += 1
            continue

        if in_code:
            code_block.append(line)
            i += 1
            continue

        stripped = line.strip()
        if not stripped:
            flush_table()
            flush_list()
            i += 1
            continue

        if stripped.startswith('### '):
            flush_table()
            flush_list()
            result.append(f'<h3>{_inline(stripped[4:])}</h3>')
        elif stripped.startswith('## '):
            flush_table()
            flush_list()
            result.append(f'<h2>{_inline(stripped[3:])}</h2>')
        elif stripped.startswith('# '):
            flush_table()
            flush_list()
            result.append(f'<h1>{_inline(stripped[2:])}</h1>')
        elif stripped.startswith('> '):
            flush_table()
            flush_list()
            block = []
            while i < len(lines) and lines[i].startswith('> '):
                block.append(lines[i][2:])
                i += 1
            result.append(f'<blockquote>{_inline("\n".join(block))}</blockquote>')
            continue
        elif stripped.startswith('- '):
            flush_table()
            in_list = True
            list_items.append(stripped)
        elif is_table_separator(stripped):
            i += 1
            continue
        elif stripped.startswith('|') and '|' in stripped[1:]:
            flush_list()
            in_table = True
            table_rows.append([cell.strip() for cell in stripped.strip('|').split('|')])
        else:
            flush_table()
            flush_list()
            result.append(f'<p>{_inline(stripped)}</p>')

        i += 1

    if in_code:
        result.append(f'<pre><code class="language-{code_lang}">{html_module.escape("\n".join(code_block))}</code></pre>')
    flush_table()
    flush_list()

    return '\n'.join(result)

def scan_math_regions(md_text):
    regions = []
    for m in re.finditer(r'(\$.*?\$|\$\$.*?\$\$)', md_text, re.DOTALL):
        regions.append({'start': m.start(), 'end': m.end(), 'content': m.group(1)})
    return regions
