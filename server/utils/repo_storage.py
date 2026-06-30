import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


def slugify_filename(title):
    slug = re.sub(r'[^a-z0-9]+', '-', (title or '').strip().lower()).strip('-')
    return slug or 'project'


def get_storage_root():
    from config import Config

    configured = getattr(Config, 'REPO_ROOT', '').strip()
    if configured:
        return Path(configured).resolve()
    server_dir = Path(__file__).resolve().parents[2]
    return server_dir.resolve()


def get_projects_root():
    from config import Config

    projects_dir = getattr(Config, 'PROJECTS_DIR', '.md-review/projects').strip() or '.md-review/projects'
    return (get_storage_root() / projects_dir).resolve()


def default_project_path(project_id, title):
    dirname = f"{slugify_filename(title)}-{project_id[:8]}"
    root = get_projects_root()
    rel_path = root.relative_to(get_storage_root()) / dirname
    return rel_path.as_posix()


def resolve_project_root(project_path):
    storage_root = get_storage_root()
    rel_path = normalize_project_relative_path(project_path)
    abs_path = (storage_root / rel_path).resolve()
    if storage_root not in abs_path.parents and abs_path != storage_root:
        raise ValueError('projectPath must stay inside storage root')
    return abs_path


def normalize_project_relative_path(project_path):
    if not project_path:
        raise ValueError('projectPath required')
    project_path = project_path.replace('\\', '/').strip()
    if project_path.startswith('/'):
        raise ValueError('projectPath must be storage-relative')
    normalized = Path(project_path)
    if normalized.is_absolute() or '..' in normalized.parts:
        raise ValueError('projectPath must stay inside storage root')
    return normalized.as_posix()


def normalize_project_file_path(file_path):
    if not file_path:
        raise ValueError('path required')
    file_path = file_path.replace('\\', '/').strip()
    if file_path.startswith('/'):
        raise ValueError('path must be project-relative')
    normalized = Path(file_path)
    if normalized.is_absolute() or '..' in normalized.parts:
        raise ValueError('path must stay inside the project')
    return normalized.as_posix()


def resolve_project_file(project_root, file_path):
    project_root = Path(project_root).resolve()
    rel_path = normalize_project_file_path(file_path)
    abs_path = (project_root / rel_path).resolve()
    if project_root not in abs_path.parents and abs_path != project_root:
        raise ValueError('path must stay inside the project')
    return abs_path


def ensure_project_repo(project_path):
    project_root = resolve_project_root(project_path)
    project_root.mkdir(parents=True, exist_ok=True)
    git_dir = project_root / '.git'
    if not git_dir.exists():
        subprocess.run(['git', '-C', str(project_root), 'init'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return project_root


def delete_project_root(project_path):
    project_root = resolve_project_root(project_path)
    shutil.rmtree(project_root, ignore_errors=True)


def ensure_project_file(project_root, file_path, content=''):
    abs_path = resolve_project_file(project_root, file_path)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    if not abs_path.exists():
        abs_path.write_text(content or '', encoding='utf-8')
    return abs_path


def read_project_file(project_root, file_path, fallback=''):
    abs_path = resolve_project_file(project_root, file_path)
    if not abs_path.exists():
        ensure_project_file(project_root, file_path, fallback)
    return abs_path.read_text(encoding='utf-8')


def write_project_file(project_root, file_path, content):
    abs_path = ensure_project_file(project_root, file_path, content)
    abs_path.write_text(content or '', encoding='utf-8')
    return abs_path


def delete_project_file(project_root, file_path):
    abs_path = resolve_project_file(project_root, file_path)
    if not abs_path.exists():
        raise FileNotFoundError(file_path)
    if abs_path.is_dir():
        shutil.rmtree(abs_path)
    else:
        abs_path.unlink()
    return abs_path


def rename_project_path(project_root, old_path, new_path):
    old_abs = resolve_project_file(project_root, old_path)
    new_abs = resolve_project_file(project_root, new_path)
    if not old_abs.exists():
        raise FileNotFoundError(old_path)
    new_abs.parent.mkdir(parents=True, exist_ok=True)
    old_abs.rename(new_abs)
    return new_abs


def sanitize_asset_filename(filename):
    original = Path((filename or '').strip()).name
    stem = re.sub(r'[^A-Za-z0-9._-]+', '-', Path(original).stem).strip('._-') or 'asset'
    suffix = re.sub(r'[^A-Za-z0-9.]+', '', Path(original).suffix)[:16].lower()
    return f'{stem}{suffix}'


def list_project_tree(project_root):
    project_root = Path(project_root).resolve()
    items = []
    for path in sorted(project_root.rglob('*')):
        rel_path = path.relative_to(project_root).as_posix()
        if rel_path == '.git' or rel_path.startswith('.git/'):
            continue
        if rel_path == '.md-review' or rel_path.startswith('.md-review/'):
            continue
        items.append({
            'path': rel_path,
            'name': path.name,
            'kind': 'dir' if path.is_dir() else 'file',
            'isMarkdown': path.is_file() and path.suffix.lower() in ('.md', '.markdown'),
        })
    return items


def get_project_head_commit(project_root):
    result = subprocess.run(
        ['git', '-C', str(project_root), 'rev-parse', 'HEAD'],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False
    )
    if result.returncode != 0:
        return None
    output = result.stdout.strip()
    return output or None


def project_repo_has_changes(project_root):
    result = subprocess.run(
        ['git', '-C', str(project_root), 'status', '--porcelain'],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False
    )
    return bool(result.stdout.strip())


def git_commit_paths(project_root, paths, message):
    normalized_paths = [normalize_project_file_path(path) for path in paths if path]
    if normalized_paths:
        subprocess.run(['git', '-C', str(project_root), 'add', '--'] + normalized_paths, check=True)
    else:
        subprocess.run(['git', '-C', str(project_root), 'add', '-A'], check=True)
    if not project_repo_has_changes(project_root):
        return get_project_head_commit(project_root)
    subprocess.run(
        [
            'git', '-C', str(project_root),
            '-c', 'user.name=MD Review',
            '-c', 'user.email=md-review@example.invalid',
            'commit', '-m', message
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    return get_project_head_commit(project_root)


def get_comments_root(project_root):
    return (Path(project_root).resolve() / '.md-review' / 'comments').resolve()


def get_comment_store_path(project_root, file_path, commit_sha):
    rel_path = normalize_project_file_path(file_path)
    commit_sha = (commit_sha or '').strip()
    if not commit_sha:
        raise ValueError('commitSha required')
    return get_comments_root(project_root) / rel_path / f'{commit_sha}.json'


def _git_is_ancestor(project_root, ancestor_commit, descendant_commit):
    try:
        result = subprocess.run(
            ['git', '-C', str(project_root), 'merge-base', '--is-ancestor', ancestor_commit, descendant_commit],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
    except Exception:
        return False
    return result.returncode == 0


def list_applicable_comment_store_commits(project_root, file_path, commit_sha):
    rel_path = normalize_project_file_path(file_path)
    commit_sha = (commit_sha or '').strip()
    if not commit_sha:
        raise ValueError('commitSha required')

    store_dir = get_comments_root(project_root) / rel_path
    if not store_dir.exists():
        return []

    matching = []
    for path in store_dir.glob('*.json'):
        candidate_commit = path.stem.strip()
        if candidate_commit == commit_sha or _git_is_ancestor(project_root, candidate_commit, commit_sha):
            matching.append(candidate_commit)
    return matching


def load_comment_store(project_root, file_path, commit_sha):
    store_path = get_comment_store_path(project_root, file_path, commit_sha)
    if not store_path.exists():
        return {
            'filePath': normalize_project_file_path(file_path),
            'commitSha': commit_sha,
            'threads': []
        }
    with store_path.open('r', encoding='utf-8') as handle:
        data = json.load(handle)
    data.setdefault('filePath', normalize_project_file_path(file_path))
    data.setdefault('commitSha', commit_sha)
    data.setdefault('threads', [])
    return data


def load_applicable_comment_stores(project_root, file_path, commit_sha):
    return [load_comment_store(project_root, file_path, item_commit) for item_commit in list_applicable_comment_store_commits(project_root, file_path, commit_sha)]


def save_comment_store(project_root, file_path, commit_sha, payload):
    store_path = get_comment_store_path(project_root, file_path, commit_sha)
    store_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        'filePath': normalize_project_file_path(file_path),
        'commitSha': commit_sha,
        'threads': payload.get('threads', [])
    }
    with tempfile.NamedTemporaryFile('w', delete=False, dir=store_path.parent, encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2)
        handle.write('\n')
        tmp_name = handle.name
    os.replace(tmp_name, store_path)
    return store_path
