import json
import os
import re
import subprocess
import tempfile
from pathlib import Path


def slugify_filename(title):
    slug = re.sub(r'[^a-z0-9]+', '-', (title or '').strip().lower()).strip('-')
    return slug or 'document'


def get_repo_root():
    from config import Config

    configured = getattr(Config, 'REPO_ROOT', '').strip()
    if configured:
        return Path(configured).resolve()

    server_dir = Path(__file__).resolve().parents[2]
    try:
        output = subprocess.check_output(
            ['git', '-C', str(server_dir), 'rev-parse', '--show-toplevel'],
            text=True
        ).strip()
        if output:
            return Path(output).resolve()
    except Exception:
        pass
    return server_dir


def get_head_commit():
    repo_root = get_repo_root()
    output = subprocess.check_output(
        ['git', '-C', str(repo_root), 'rev-parse', 'HEAD'],
        text=True
    ).strip()
    if not output:
        raise RuntimeError('Unable to determine git HEAD')
    return output


def get_comments_root():
    from config import Config

    comments_dir = getattr(Config, 'COMMENTS_DIR', '.md-review/comments').strip() or '.md-review/comments'
    return (get_repo_root() / comments_dir).resolve()


def get_documents_root():
    from config import Config

    documents_dir = getattr(Config, 'DOCUMENTS_DIR', '.md-review/documents').strip() or '.md-review/documents'
    return (get_repo_root() / documents_dir).resolve()


def normalize_repo_relative_path(file_path):
    if not file_path:
        raise ValueError('filePath required')
    file_path = file_path.replace('\\', '/').strip()
    if file_path.startswith('/'):
        raise ValueError('filePath must be repository-relative')
    normalized = Path(file_path)
    if normalized.is_absolute() or '..' in normalized.parts:
        raise ValueError('filePath must stay inside the repository')
    return normalized.as_posix()


def resolve_repo_file(file_path):
    repo_root = get_repo_root()
    rel_path = normalize_repo_relative_path(file_path)
    abs_path = (repo_root / rel_path).resolve()
    if repo_root not in abs_path.parents and abs_path != repo_root:
        raise ValueError('filePath must stay inside the repository')
    return abs_path


def ensure_repo_file(file_path, markdown=''):
    abs_path = resolve_repo_file(file_path)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    if not abs_path.exists():
        abs_path.write_text(markdown or '', encoding='utf-8')
    return abs_path


def read_repo_file(file_path, fallback_markdown=''):
    abs_path = resolve_repo_file(file_path)
    if not abs_path.exists():
        ensure_repo_file(file_path, fallback_markdown)
    return abs_path.read_text(encoding='utf-8')


def write_repo_file(file_path, markdown):
    abs_path = ensure_repo_file(file_path, markdown)
    abs_path.write_text(markdown or '', encoding='utf-8')
    return abs_path


def default_repo_path(doc_id, title):
    filename = f'{slugify_filename(title)}-{doc_id[:8]}.md'
    root = get_documents_root()
    rel_path = root.relative_to(get_repo_root()) / filename
    return rel_path.as_posix()


def get_comment_store_path(file_path, commit_sha):
    rel_path = normalize_repo_relative_path(file_path)
    commit_sha = (commit_sha or '').strip()
    if not commit_sha:
        raise ValueError('commitSha required')
    return get_comments_root() / rel_path / f'{commit_sha}.json'


def load_comment_store(file_path, commit_sha):
    store_path = get_comment_store_path(file_path, commit_sha)
    if not store_path.exists():
        return {
            'filePath': normalize_repo_relative_path(file_path),
            'commitSha': commit_sha,
            'threads': []
        }
    with store_path.open('r', encoding='utf-8') as handle:
        data = json.load(handle)
    data.setdefault('filePath', normalize_repo_relative_path(file_path))
    data.setdefault('commitSha', commit_sha)
    data.setdefault('threads', [])
    return data


def save_comment_store(file_path, commit_sha, payload):
    store_path = get_comment_store_path(file_path, commit_sha)
    store_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        'filePath': normalize_repo_relative_path(file_path),
        'commitSha': commit_sha,
        'threads': payload.get('threads', [])
    }
    with tempfile.NamedTemporaryFile('w', delete=False, dir=store_path.parent, encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2)
        handle.write('\n')
        tmp_name = handle.name
    os.replace(tmp_name, store_path)
    return store_path
