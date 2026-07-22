import fcntl
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

COMMIT_SHA_RE = re.compile(r'^[0-9a-fA-F]{40,64}$')
RESERVED_PROJECT_PATHS = {'.git', '.md-review'}
SCP_REPOSITORY_URL_RE = re.compile(r'^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?P<path>[^\s]+)$')

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
    storage_root = get_storage_root()
    projects_root = (storage_root / projects_dir).resolve()
    if projects_root == storage_root or storage_root not in projects_root.parents:
        raise ValueError('Project storage must be inside the configured repository root')
    return projects_root


def default_project_path(project_id, title):
    dirname = f"{slugify_filename(title)}-{project_id[:8]}"
    root = get_projects_root()
    rel_path = root.relative_to(get_storage_root()) / dirname
    return rel_path.as_posix()


def normalize_repository_url(repository_url):
    repository_url = str(repository_url or '').strip()
    if not repository_url:
        raise ValueError('repositoryUrl required')
    if len(repository_url) > 2048 or any(character.isspace() for character in repository_url):
        raise ValueError('Invalid repository URL')

    scp_match = SCP_REPOSITORY_URL_RE.fullmatch(repository_url)
    if scp_match:
        if not scp_match.group('path').strip('/'):
            raise ValueError('Invalid repository URL')
        return repository_url

    try:
        parsed = urlsplit(repository_url)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ValueError('Invalid repository URL') from exc
    if parsed.scheme not in ('https', 'ssh') or not hostname or not parsed.path.strip('/'):
        raise ValueError('Repository URL must use HTTPS or SSH')
    if parsed.fragment or parsed.query or parsed.password:
        raise ValueError('Repository URL cannot include credentials, query parameters, or fragments')
    if parsed.scheme == 'https' and parsed.username:
        raise ValueError('Repository URL cannot include credentials')
    if port is not None and not 1 <= port <= 65535:
        raise ValueError('Invalid repository URL')
    return repository_url


def repository_title_from_url(repository_url):
    repository_url = normalize_repository_url(repository_url)
    scp_match = SCP_REPOSITORY_URL_RE.fullmatch(repository_url)
    path = scp_match.group('path') if scp_match else urlsplit(repository_url).path
    title = Path(path.rstrip('/')).name
    if title.lower().endswith('.git'):
        title = title[:-4]
    return title or 'Imported project'


def resolve_project_root(project_path):
    storage_root = get_storage_root()
    rel_path = normalize_project_relative_path(project_path)
    abs_path = (storage_root / rel_path).resolve()
    projects_root = get_projects_root()
    if abs_path == projects_root or projects_root not in abs_path.parents:
        raise ValueError('projectPath must stay inside the managed projects directory')
    return abs_path


def normalize_project_relative_path(project_path):
    if not project_path:
        raise ValueError('projectPath required')
    project_path = project_path.replace('\\', '/').strip()
    if project_path.startswith('/'):
        raise ValueError('projectPath must be storage-relative')
    normalized = Path(project_path)
    if normalized.is_absolute() or '..' in normalized.parts or normalized.as_posix() == '.':
        raise ValueError('projectPath must stay inside storage root')
    return normalized.as_posix()


def normalize_project_file_path(file_path):
    if not file_path:
        raise ValueError('path required')
    file_path = file_path.replace('\\', '/').strip()
    if file_path.startswith('/'):
        raise ValueError('path must be project-relative')
    normalized = Path(file_path)
    if normalized.is_absolute() or '..' in normalized.parts or normalized.as_posix() == '.':
        raise ValueError('path must stay inside the project')
    if normalized.parts and normalized.parts[0] in RESERVED_PROJECT_PATHS:
        raise ValueError('Internal project paths cannot be modified')
    return normalized.as_posix()


def resolve_project_file(project_root, file_path):
    project_root = Path(project_root).resolve()
    rel_path = normalize_project_file_path(file_path)
    abs_path = (project_root / rel_path).resolve()
    if abs_path == project_root or project_root not in abs_path.parents:
        raise ValueError('path must stay inside the project')
    return abs_path


@contextmanager
def project_write_lock(project_root):
    """Serialize project writes across Gunicorn workers and threads."""
    project_root = Path(project_root).resolve()
    git_dir = project_root / '.git'
    if not git_dir.is_dir():
        raise ValueError('Project repository is not initialized')
    with (git_dir / 'md-review-write.lock').open('a+', encoding='utf-8') as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def ensure_project_repo(project_path):
    project_root = resolve_project_root(project_path)
    project_root.mkdir(parents=True, exist_ok=True)
    git_dir = project_root / '.git'
    if not git_dir.exists():
        subprocess.run(['git', '-C', str(project_root), 'init'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    exclude_path = git_dir / 'info' / 'exclude'
    exclude_path.parent.mkdir(parents=True, exist_ok=True)
    existing = exclude_path.read_text(encoding='utf-8') if exclude_path.exists() else ''
    if '.md-review/' not in {line.strip() for line in existing.splitlines()}:
        separator = '' if not existing or existing.endswith('\n') else '\n'
        with exclude_path.open('a', encoding='utf-8') as exclude_file:
            exclude_file.write(f'{separator}.md-review/\n')
    return project_root


def clone_project_repo(project_path, repository_url):
    from config import Config

    repository_url = normalize_repository_url(repository_url)
    project_root = resolve_project_root(project_path)
    if project_root.exists():
        raise ValueError('Project destination already exists')
    project_root.parent.mkdir(parents=True, exist_ok=True)
    clone_env = os.environ.copy()
    clone_env.update({
        'GIT_ALLOW_PROTOCOL': 'https:ssh',
        'GIT_TERMINAL_PROMPT': '0',
    })
    if repository_url.startswith('ssh://') or SCP_REPOSITORY_URL_RE.fullmatch(repository_url):
        clone_env.setdefault('GIT_SSH_COMMAND', 'ssh -oBatchMode=yes')
    timeout = max(1, int(getattr(Config, 'GIT_IMPORT_TIMEOUT_SECONDS', 120)))
    try:
        subprocess.run(
            ['git', 'clone', '--no-hardlinks', '--', repository_url, str(project_root)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            env=clone_env,
        )
        tracked_internal = subprocess.run(
            ['git', '-C', str(project_root), 'ls-files', '--', '.md-review'],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if tracked_internal:
            raise ValueError('Repository uses the reserved .md-review path')
        return ensure_project_repo(project_path)
    except subprocess.TimeoutExpired as exc:
        shutil.rmtree(project_root, ignore_errors=True)
        raise ValueError(f'Repository import timed out after {timeout} seconds') from exc
    except subprocess.CalledProcessError as exc:
        shutil.rmtree(project_root, ignore_errors=True)
        raise ValueError('Unable to clone repository; check the URL and server access') from exc
    except Exception:
        shutil.rmtree(project_root, ignore_errors=True)
        raise



def archive_title_from_filename(filename):
    name = Path(str(filename or '').replace('\\', '/')).name
    lowered = name.lower()
    for suffix in ('.tar.gz', '.tgz', '.zip'):
        if lowered.endswith(suffix):
            name = name[:-len(suffix)]
            break
    return name.strip() or 'Imported project'


def _safe_archive_parts(name):
    name = str(name or '').replace('\\', '/')
    if not name or '\x00' in name or name.startswith('/') or re.match(r'^[A-Za-z]:/', name):
        raise ValueError('Archive contains an unsafe path')
    parts = tuple(part for part in name.split('/') if part not in ('', '.'))
    if any(part == '..' for part in parts):
        raise ValueError('Archive contains an unsafe path')
    return parts


def _prepare_archive_entries(entries, max_files, max_bytes):
    entries = [
        entry for entry in entries
        if entry['parts'] and entry['parts'][0] != '__MACOSX'
    ]
    roots = {entry['parts'][0] for entry in entries}
    explicit_roots = {
        entry['parts'][0]
        for entry in entries
        if entry['is_dir'] and len(entry['parts']) == 1
    }
    # ZIP creators commonly omit directory entries entirely. A single shared
    # first component still represents the exported project wrapper when every
    # archived item is below it.
    has_wrapped_files = bool(entries) and all(len(entry['parts']) > 1 for entry in entries)
    strip_root = (
        next(iter(roots))
        if len(roots) == 1 and (roots <= explicit_roots or has_wrapped_files)
        else None
    )

    prepared = []
    seen = {}
    file_count = 0
    total_size = 0
    for entry in entries:
        parts = entry['parts'][1:] if strip_root else entry['parts']
        if not parts:
            continue
        if parts[0] == '.md-review' and len(parts) > 1 and parts[1] != 'comments':
            raise ValueError('Archive uses a reserved .md-review path')
        path = '/'.join(parts)
        previous = seen.get(path)
        if previous is not None:
            if previous and entry['is_dir']:
                continue
            raise ValueError(f'Archive contains duplicate path: {path}')
        seen[path] = entry['is_dir']
        if not entry['is_dir']:
            file_count += 1
            total_size += entry['size']
        prepared.append({**entry, 'parts': parts, 'path': path})

    file_paths = {path for path, is_dir in seen.items() if not is_dir}
    for path in seen:
        parts = path.split('/')
        if any('/'.join(parts[:index]) in file_paths for index in range(1, len(parts))):
            raise ValueError(f'Archive path conflicts with a file: {path}')
    if file_count > max_files:
        raise ValueError(f'Archive contains more than {max_files} files')
    if total_size > max_bytes:
        raise ValueError(f'Archive expands beyond {max_bytes} bytes')
    return prepared


def _extract_archive_entries(project_root, entries, open_entry, max_bytes):
    extracted_bytes = 0
    for entry in entries:
        destination = project_root.joinpath(*entry['parts'])
        if entry['is_dir']:
            destination.mkdir(parents=True, exist_ok=True)
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        with open_entry(entry['source']) as source, destination.open('wb') as target:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                extracted_bytes += len(chunk)
                if extracted_bytes > max_bytes:
                    raise ValueError(f'Archive expands beyond {max_bytes} bytes')
                target.write(chunk)
        if entry['mode'] & 0o111:
            destination.chmod(destination.stat().st_mode | 0o111)


def _sanitize_archived_git_repo(project_root):
    git_dir = project_root / '.git'
    if not git_dir.is_dir():
        raise ValueError('Archived .git path must be a directory')
    shutil.rmtree(git_dir / 'hooks', ignore_errors=True)
    for relative_path in (
        'config.worktree',
        'index',
        'objects/info/alternates',
        'objects/info/http-alternates',
    ):
        path = git_dir / relative_path
        if path.exists():
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
    (git_dir / 'config').write_text(
        '[core]\n'
        '\trepositoryformatversion = 0\n'
        '\tfilemode = true\n'
        '\tbare = false\n'
        '\tlogallrefupdates = true\n',
        encoding='utf-8',
    )
    result = subprocess.run(
        ['git', '-C', str(project_root), 'rev-parse', '--is-inside-work-tree'],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or result.stdout.strip() != 'true':
        raise ValueError('Archive does not contain a valid Git worktree')
    head = get_project_head_commit(project_root)
    if head:
        subprocess.run(
            ['git', '-C', str(project_root), 'reset', '--mixed', 'HEAD'],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def import_project_archive(project_path, archive_path, archive_name=''):
    from config import Config

    project_root = resolve_project_root(project_path)
    if project_root.exists():
        raise ValueError('Project destination already exists')
    project_root.parent.mkdir(parents=True, exist_ok=True)
    project_root.mkdir()
    max_files = max(1, int(getattr(Config, 'ARCHIVE_IMPORT_MAX_FILES', 10000)))
    max_bytes = max(1, int(getattr(Config, 'ARCHIVE_IMPORT_MAX_EXTRACTED_BYTES', 500 * 1024 * 1024)))
    archive_path = Path(archive_path)
    lowered_name = str(archive_name or archive_path.name).lower()

    try:
        if lowered_name.endswith('.zip'):
            with zipfile.ZipFile(archive_path) as archive:
                raw_entries = []
                for info in archive.infolist():
                    mode = (info.external_attr >> 16) & 0xFFFF
                    if stat.S_ISLNK(mode):
                        raise ValueError('Archive links are not supported')
                    raw_entries.append({
                        'source': info,
                        'parts': _safe_archive_parts(info.filename),
                        'is_dir': info.is_dir(),
                        'size': info.file_size,
                        'mode': mode,
                    })
                entries = _prepare_archive_entries(raw_entries, max_files, max_bytes)
                _extract_archive_entries(project_root, entries, archive.open, max_bytes)
        elif lowered_name.endswith(('.tar.gz', '.tgz')):
            with tarfile.open(archive_path, 'r:gz') as archive:
                raw_entries = []
                for member in archive.getmembers():
                    if not member.isdir() and not member.isfile():
                        raise ValueError('Archive links and special files are not supported')
                    raw_entries.append({
                        'source': member,
                        'parts': _safe_archive_parts(member.name),
                        'is_dir': member.isdir(),
                        'size': member.size,
                        'mode': member.mode,
                    })
                entries = _prepare_archive_entries(raw_entries, max_files, max_bytes)
                _extract_archive_entries(
                    project_root,
                    entries,
                    lambda member: archive.extractfile(member),
                    max_bytes,
                )
        else:
            raise ValueError('Archive must be a .tar.gz, .tgz, or .zip file')

        git_dir = project_root / '.git'
        if git_dir.exists():
            _sanitize_archived_git_repo(project_root)
        project_root = ensure_project_repo(project_path)
        git_commit_paths(project_root, [], 'Import archive')
        return project_root
    except (tarfile.TarError, zipfile.BadZipFile) as exc:
        shutil.rmtree(project_root, ignore_errors=True)
        raise ValueError('Invalid or corrupted project archive') from exc
    except Exception:
        shutil.rmtree(project_root, ignore_errors=True)
        raise


def list_project_file_history(project_root, file_path):
    # Return UTF-8 versions of one file in chronological Git order.
    project_root = Path(project_root).resolve()
    file_path = normalize_project_file_path(file_path)
    result = subprocess.run(
        [
            'git', '-C', str(project_root), 'log', '--reverse',
            '--format=%H%x00%cI%x00%s', '--', file_path,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    history = []
    for line in result.stdout.splitlines():
        parts = line.split('\x00', 2)
        if len(parts) != 3:
            continue
        commit_sha, created_at, message = parts
        content = subprocess.run(
            ['git', '-C', str(project_root), 'show', f'{commit_sha}:{file_path}'],
            check=False,
            capture_output=True,
        )
        if content.returncode != 0:
            continue
        try:
            decoded_content = content.stdout.decode('utf-8')
        except UnicodeDecodeError:
            continue
        history.append({
            'commitSha': commit_sha,
            'createdAt': created_at,
            'message': message or 'Imported repository',
            'content': decoded_content,
        })
    return history


def rebind_imported_comment_project(project_root, project_id):
    # Associate restored comment threads with their newly assigned project ID.
    comments_root = get_comments_root(project_root)
    if not comments_root.exists():
        return 0
    rebound = 0
    for store_path in comments_root.rglob('*.json'):
        try:
            with store_path.open('r', encoding='utf-8') as handle:
                payload = json.load(handle)
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError(f'Invalid comment data in {store_path.name}') from exc
        if not isinstance(payload, dict):
            raise ValueError(f'Invalid comment data in {store_path.name}')
        threads = payload.get('threads', [])
        if not isinstance(threads, list):
            raise ValueError(f'Invalid comment data in {store_path.name}')
        changed = False
        for thread in threads:
            if not isinstance(thread, dict):
                raise ValueError(f'Invalid comment data in {store_path.name}')
            if thread.get('projectId') != project_id:
                thread['projectId'] = project_id
                changed = True
                rebound += 1
        if not changed:
            continue
        with tempfile.NamedTemporaryFile(
            'w', delete=False, dir=store_path.parent, encoding='utf-8'
        ) as handle:
            json.dump(payload, handle, indent=2)
            handle.write('\n')
            temporary_path = handle.name
        os.replace(temporary_path, store_path)
    return rebound


def build_project_archive(project_root, archive_path, root_name=None):
    project_root = Path(project_root).resolve()
    archive_path = Path(archive_path).resolve()
    root_name = root_name or project_root.name
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, 'w:gz') as archive:
        archive.add(project_root, arcname=root_name)
    return archive_path


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
    if new_abs.exists():
        raise FileExistsError(new_path)
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


def find_file_content_commit(project_root, file_path, content):
    """Find the newest commit where file_path had exactly content."""
    rel_path = normalize_project_file_path(file_path)
    history = subprocess.run(
        ['git', '-C', str(Path(project_root).resolve()), 'log', '--format=%H', '--all', '--', rel_path],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    for commit_sha in history.stdout.splitlines():
        candidate = subprocess.run(
            ['git', '-C', str(Path(project_root).resolve()), 'show', f'{commit_sha}:{rel_path}'],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if candidate.returncode == 0 and candidate.stdout == content:
            return normalize_project_commit(project_root, commit_sha)
    return None


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


def reset_project_to_commit(project_root, commit_sha):
    canonical = normalize_project_commit(project_root, commit_sha)
    subprocess.run(
        ['git', '-C', str(Path(project_root).resolve()), 'reset', '--hard', canonical],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return canonical


def get_comments_root(project_root):
    project_root = Path(project_root).resolve()
    comments_root = (project_root / '.md-review' / 'comments').resolve()
    if comments_root == project_root or project_root not in comments_root.parents:
        raise ValueError('Comment storage must stay inside the project')
    return comments_root


def normalize_project_commit(project_root, commit_sha):
    commit_sha = str(commit_sha or '').strip()
    if not COMMIT_SHA_RE.fullmatch(commit_sha):
        raise ValueError('Invalid commitSha')
    result = subprocess.run(
        ['git', '-C', str(Path(project_root).resolve()), 'rev-parse', '--verify', f'{commit_sha}^{{commit}}'],
        check=False,
        capture_output=True,
        text=True,
    )
    canonical = result.stdout.strip().lower()
    if result.returncode != 0 or not COMMIT_SHA_RE.fullmatch(canonical):
        raise ValueError('commitSha does not identify a project commit')
    return canonical


def get_comment_file_store_dir(project_root, file_path):
    comments_root = get_comments_root(project_root)
    rel_path = normalize_project_file_path(file_path)
    store_dir = (comments_root / rel_path).resolve()
    if store_dir == comments_root or comments_root not in store_dir.parents:
        raise ValueError('Comment path escapes comment storage')
    return store_dir


def get_comment_store_path(project_root, file_path, commit_sha):
    store_dir = get_comment_file_store_dir(project_root, file_path)
    canonical_commit = normalize_project_commit(project_root, commit_sha)
    store_path = (store_dir / f'{canonical_commit}.json').resolve()
    if store_dir not in store_path.parents:
        raise ValueError('Comment commit path escapes comment storage')
    return store_path


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
    canonical_commit = normalize_project_commit(project_root, commit_sha)
    store_dir = get_comment_file_store_dir(project_root, file_path)
    if not store_dir.exists():
        return []

    matching = []
    for path in store_dir.glob('*.json'):
        try:
            candidate_commit = normalize_project_commit(project_root, path.stem)
        except ValueError:
            continue
        if candidate_commit == canonical_commit or _git_is_ancestor(project_root, candidate_commit, canonical_commit):
            matching.append(candidate_commit)
    return matching


def load_comment_store(project_root, file_path, commit_sha):
    canonical_commit = normalize_project_commit(project_root, commit_sha)
    store_path = get_comment_store_path(project_root, file_path, canonical_commit)
    if not store_path.exists():
        return {
            'filePath': normalize_project_file_path(file_path),
            'commitSha': canonical_commit,
            'threads': []
        }
    with store_path.open('r', encoding='utf-8') as handle:
        data = json.load(handle)
    data.setdefault('filePath', normalize_project_file_path(file_path))
    data.setdefault('commitSha', canonical_commit)
    data.setdefault('threads', [])
    return data


def load_applicable_comment_stores(project_root, file_path, commit_sha):
    return [load_comment_store(project_root, file_path, item_commit) for item_commit in list_applicable_comment_store_commits(project_root, file_path, commit_sha)]


def save_comment_store(project_root, file_path, commit_sha, payload):
    canonical_commit = normalize_project_commit(project_root, commit_sha)
    store_path = get_comment_store_path(project_root, file_path, canonical_commit)
    store_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        'filePath': normalize_project_file_path(file_path),
        'commitSha': canonical_commit,
        'threads': payload.get('threads', [])
    }
    with tempfile.NamedTemporaryFile('w', delete=False, dir=store_path.parent, encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2)
        handle.write('\n')
        tmp_name = handle.name
    os.replace(tmp_name, store_path)
    return store_path


def replace_comment_history(project_root, file_path, commit_sha, threads):
    """Replace one file's comment history with a restored checkpoint."""
    store_dir = get_comment_file_store_dir(project_root, file_path)
    if store_dir.exists():
        shutil.rmtree(store_dir)
    return save_comment_store(project_root, file_path, commit_sha, {'threads': threads})


def rename_comment_store_path(project_root, old_path, new_path):
    """Move comment history with a renamed file or directory."""
    old_path = normalize_project_file_path(old_path)
    new_path = normalize_project_file_path(new_path)
    old_store = get_comment_file_store_dir(project_root, old_path)
    new_store = get_comment_file_store_dir(project_root, new_path)
    if not old_store.exists():
        return False
    if new_store.exists():
        raise FileExistsError(f'Comment history already exists for {new_path}')

    new_store.parent.mkdir(parents=True, exist_ok=True)
    old_store.rename(new_store)
    comments_root = get_comments_root(project_root)
    for store_path in new_store.rglob('*.json'):
        relative_file_path = store_path.parent.relative_to(comments_root).as_posix()
        with store_path.open('r', encoding='utf-8') as handle:
            payload = json.load(handle)
        payload['filePath'] = relative_file_path
        for thread in payload.get('threads', []):
            thread_path = thread.get('filePath')
            if thread_path == old_path:
                thread['filePath'] = new_path
            elif isinstance(thread_path, str) and thread_path.startswith(f'{old_path}/'):
                thread['filePath'] = f'{new_path}{thread_path[len(old_path):]}'
        save_comment_store(project_root, relative_file_path, store_path.stem, payload)
    return True
