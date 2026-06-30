import uuid
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request, session

from models import get_db, get_project_for_user, user_can_edit_project
from utils.diff import compute_diff
from utils.repo_storage import (
    get_project_head_commit,
    git_commit_paths,
    load_applicable_comment_stores,
    load_comment_store,
    list_applicable_comment_store_commits,
    normalize_project_file_path,
    read_project_file,
    resolve_project_root,
    save_comment_store,
    write_project_file,
)


review_bp = Blueprint('review', __name__)


def require_auth(f):
    from functools import wraps

    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Not authenticated'}), 401
        return f(*args, **kwargs)

    return decorated


def require_project_access(project_id, user_id):
    if not get_project_for_user(project_id, user_id):
        return jsonify({'error': 'Not found'}), 404
    return None


def require_project_edit(project_id, user_id):
    access_error = require_project_access(project_id, user_id)
    if access_error:
        return access_error
    if not user_can_edit_project(project_id, user_id):
        return jsonify({'error': 'Forbidden'}), 403
    return None


def normalize_comment_context(data):
    if not data or not data.get('projectId'):
        return None, (jsonify({'error': 'projectId required'}), 400)
    if not data.get('commitSha'):
        return None, (jsonify({'error': 'commitSha required'}), 400)
    if not data.get('filePath'):
        return None, (jsonify({'error': 'filePath required'}), 400)
    try:
        file_path = normalize_project_file_path(data['filePath'])
    except ValueError as exc:
        return None, (jsonify({'error': str(exc)}), 400)
    project = get_project_for_user(data['projectId'], session['user_id'])
    if not project:
        return None, (jsonify({'error': 'Not found'}), 404)
    return {
        'projectId': data['projectId'],
        'projectRoot': resolve_project_root(project['project_path']),
        'commitSha': data['commitSha'],
        'filePath': file_path,
    }, None


def serialize_thread(thread):
    thread = dict(thread)
    thread.setdefault('comments', [])
    thread.setdefault('anchor', None)
    thread.setdefault('resolved', False)
    thread.setdefault('resolvedBy', None)
    thread.setdefault('resolvedAt', None)
    return thread


def require_thread_edit_context(thread_id, uid, data):
    context, error = normalize_comment_context(data)
    if error:
        return None, None, error
    access_error = require_project_access(context['projectId'], uid)
    if access_error:
        return None, None, access_error
    for store in load_applicable_comment_stores(context['projectRoot'], context['filePath'], context['commitSha']):
        thread = next((item for item in store.get('threads', []) if item.get('id') == thread_id), None)
        if thread:
            context['commitSha'] = store.get('commitSha', context['commitSha'])
            return context, store, None
    return None, None, (jsonify({'error': 'Not found'}), 404)


@review_bp.route('/projects/<project_id>/files/versions', methods=['GET'])
@require_auth
def list_versions(project_id):
    access_error = require_project_access(project_id, session['user_id'])
    if access_error:
        return access_error
    try:
        file_path = normalize_project_file_path(request.args.get('path', ''))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    rows = get_db().execute(
        "SELECT fv.*, u.username AS author_name "
        "FROM file_versions fv "
        "JOIN users u ON fv.author_id = u.id "
        "WHERE fv.project_id = ? AND fv.file_path = ? "
        "ORDER BY fv.version DESC",
        (project_id, file_path)
    ).fetchall()
    return jsonify([dict(row) for row in rows])


@review_bp.route('/projects/<project_id>/files/compare', methods=['POST'])
@require_auth
def compare_versions(project_id):
    access_error = require_project_access(project_id, session['user_id'])
    if access_error:
        return access_error

    data = request.get_json() or {}
    version_a = data.get('versionA')
    version_b = data.get('versionB')
    try:
        file_path = normalize_project_file_path(data.get('path', ''))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not version_a or not version_b:
        return jsonify({'error': 'versionA and versionB required'}), 400

    conn = get_db()
    va = conn.execute(
        "SELECT * FROM file_versions WHERE id = ? AND project_id = ? AND file_path = ?",
        (version_a, project_id, file_path)
    ).fetchone()
    vb = conn.execute(
        "SELECT * FROM file_versions WHERE id = ? AND project_id = ? AND file_path = ?",
        (version_b, project_id, file_path)
    ).fetchone()
    if not va or not vb:
        return jsonify({'error': 'Version not found'}), 404

    diff_rows = compute_diff(va['content'], vb['content'])
    return jsonify({
        'diff': diff_rows,
        'versionA': va['version'],
        'versionB': vb['version'],
        'createdAtA': va['created_at'],
        'createdAtB': vb['created_at'],
    })


@review_bp.route('/projects/<project_id>/files/versions/<version_id>/revert', methods=['POST'])
@require_auth
def revert_version(project_id, version_id):
    uid = session['user_id']
    edit_error = require_project_edit(project_id, uid)
    if edit_error:
        return edit_error

    conn = get_db()
    version = conn.execute(
        "SELECT * FROM file_versions WHERE id = ? AND project_id = ?",
        (version_id, project_id)
    ).fetchone()
    if not version:
        return jsonify({'error': 'Version not found'}), 404

    project = get_project_for_user(project_id, uid)
    project_root = resolve_project_root(project['project_path'])
    current_content = ''
    try:
        current_content = read_project_file(project_root, version['file_path'], '')
    except Exception:
        current_content = ''

    now = datetime.now(timezone.utc).isoformat()
    write_project_file(project_root, version['file_path'], version['content'])
    head = git_commit_paths(project_root, [version['file_path']], f'Revert {version["file_path"]}')
    next_version = conn.execute(
        "SELECT COALESCE(MAX(version), 0) + 1 FROM file_versions WHERE project_id = ? AND file_path = ?",
        (project_id, version['file_path'])
    ).fetchone()[0]
    author = conn.execute("SELECT username FROM users WHERE id = ?", (uid,)).fetchone()
    author_name = author['username'] if author else uid
    conn.execute(
        "INSERT INTO file_versions (id, project_id, file_path, version, content, diff, message, author_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            str(uuid.uuid4()),
            project_id,
            version['file_path'],
            next_version,
            version['content'],
            '[]',
            f"Reverted to v{version['version']} by {author_name}",
            uid,
            now,
        )
    )
    conn.execute(
        "UPDATE projects SET updated_by = ?, updated_at = ? WHERE id = ?",
        (uid, now, project_id)
    )
    conn.commit()
    return jsonify({
        'ok': True,
        'filePath': version['file_path'],
        'content': version['content'],
        'currentCommitSha': head,
        'diff': compute_diff(current_content, version['content']),
    })


@review_bp.route('/comments/threads', methods=['POST'])
@require_auth
def create_thread():
    uid = session['user_id']
    data = request.get_json()
    context, error = normalize_comment_context(data)
    if error:
        return error

    thread_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    store = load_comment_store(context['projectRoot'], context['filePath'], context['commitSha'])
    thread = {
        'id': thread_id,
        'projectId': context['projectId'],
        'filePath': context['filePath'],
        'commitSha': context['commitSha'],
        'createdBy': uid,
        'createdAt': now,
        'createdByUsername': session.get('username', ''),
        'resolved': False,
        'resolvedBy': None,
        'resolvedAt': None,
        'comments': [],
        'anchor': None,
    }

    if data.get('body'):
        thread['comments'].append({
            'id': str(uuid.uuid4()),
            'threadId': thread_id,
            'userId': uid,
            'body': data['body'],
            'createdAt': now,
            'username': session.get('username', ''),
        })

    if data.get('anchor'):
        anchor = data['anchor']
        thread['anchor'] = {
            'startLine': anchor.get('startLine', 1),
            'endLine': anchor.get('endLine', 1),
            'startOffset': anchor.get('startOffset'),
            'endOffset': anchor.get('endOffset'),
            'selectedText': anchor.get('selectedText'),
        }

    store['threads'].append(thread)
    save_comment_store(context['projectRoot'], context['filePath'], context['commitSha'], store)
    return jsonify({
        'id': thread_id,
        'projectId': context['projectId'],
        'filePath': context['filePath'],
        'commitSha': context['commitSha'],
        'createdBy': uid,
        'createdAt': now,
    }), 201


@review_bp.route('/comment-lines', methods=['POST'])
@require_auth
def add_comment():
    uid = session['user_id']
    data = request.get_json()
    if not data or 'threadId' not in data or 'body' not in data:
        return jsonify({'error': 'threadId and body required'}), 400
    context, store, error = require_thread_edit_context(data['threadId'], uid, data)
    if error:
        return error

    comment_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    thread = next(item for item in store['threads'] if item['id'] == data['threadId'])
    thread.setdefault('comments', []).append({
        'id': comment_id,
        'threadId': data['threadId'],
        'userId': uid,
        'body': data['body'],
        'createdAt': now,
        'username': session.get('username', ''),
    })
    save_comment_store(context['projectRoot'], context['filePath'], context['commitSha'], store)
    return jsonify({'id': comment_id, 'threadId': data['threadId'], 'userId': uid, 'body': data['body'], 'createdAt': now}), 201


@review_bp.route('/projects/<project_id>/threads', methods=['GET'])
@require_auth
def list_threads(project_id):
    access_error = require_project_access(project_id, session['user_id'])
    if access_error:
        return access_error
    commit_sha = request.args.get('commitSha')
    file_path = request.args.get('filePath')
    if not commit_sha or not file_path:
        return jsonify([])
    try:
        file_path = normalize_project_file_path(file_path)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    project = get_project_for_user(project_id, session['user_id'])
    project_root = resolve_project_root(project['project_path'])
    stores = load_applicable_comment_stores(project_root, file_path, commit_sha)
    merged_threads = []
    for store in stores:
        merged_threads.extend(store.get('threads', []))
    threads = [
        serialize_thread(thread)
        for thread in sorted(merged_threads, key=lambda item: item.get('createdAt', ''), reverse=True)
        if thread.get('projectId') == project_id
    ]
    return jsonify(threads)


@review_bp.route('/comments/threads/<thread_id>/resolve', methods=['POST'])
@require_auth
def toggle_resolve(thread_id):
    uid = session['user_id']
    data = request.get_json() or {}
    context, store, error = require_thread_edit_context(thread_id, uid, data)
    if error:
        return error
    edit_error = require_project_edit(context['projectId'], uid)
    if edit_error:
        return edit_error

    now = datetime.now(timezone.utc).isoformat()
    thread = next(item for item in store['threads'] if item['id'] == thread_id)
    new_resolved = not bool(thread.get('resolved'))
    thread['resolved'] = new_resolved
    thread['resolvedBy'] = uid if new_resolved else None
    thread['resolvedAt'] = now if new_resolved else None
    save_comment_store(context['projectRoot'], context['filePath'], context['commitSha'], store)
    return jsonify({
        'id': thread_id,
        'resolved': bool(new_resolved),
        'resolvedBy': thread['resolvedBy'],
        'resolvedAt': thread['resolvedAt'],
    })


@review_bp.route('/comments/threads/<thread_id>', methods=['DELETE'])
@require_auth
def delete_thread(thread_id):
    uid = session['user_id']
    data = request.get_json() or {}
    context, store, error = require_thread_edit_context(thread_id, uid, data)
    if error:
        return error
    edit_error = require_project_edit(context['projectId'], uid)
    if edit_error:
        return edit_error

    thread = next(item for item in store['threads'] if item['id'] == thread_id)
    if not thread.get('resolved'):
        return jsonify({'error': 'Resolved thread required'}), 400

    changed = False
    for item_commit in list_applicable_comment_store_commits(context['projectRoot'], context['filePath'], context['commitSha']):
        item_store = load_comment_store(context['projectRoot'], context['filePath'], item_commit)
        original_count = len(item_store.get('threads', []))
        item_store['threads'] = [item for item in item_store.get('threads', []) if item.get('id') != thread_id]
        if len(item_store['threads']) != original_count:
            save_comment_store(context['projectRoot'], context['filePath'], item_commit, item_store)
            changed = True
    return jsonify({'id': thread_id, 'deleted': changed})
