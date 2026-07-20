import os
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from urllib.parse import quote

from flask import Blueprint, after_this_request, current_app, jsonify, request, send_file, session

from models import (
    acquire_project_lock,
    get_db,
    get_project_for_user,
    project_lock_is_expired,
    refresh_project_lock,
    release_project_lock,
)
from utils.repo_storage import (
    build_project_archive,
    default_project_path,
    delete_project_file,
    delete_project_root,
    ensure_project_file,
    ensure_project_repo,
    get_comment_file_store_dir,
    get_project_head_commit,
    git_commit_paths,
    list_project_tree,
    normalize_project_file_path,
    project_write_lock,
    read_project_file,
    rename_project_path,
    rename_comment_store_path,
    resolve_project_file,
    resolve_project_root,
    sanitize_asset_filename,
    write_project_file,
)


project_bp = Blueprint('projects', __name__)
SHARE_ROLES = {'viewer', 'editor'}
MARKDOWN_EXTENSIONS = {'.md', '.markdown'}


def require_auth(f):
    from functools import wraps

    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Not authenticated'}), 401
        return f(*args, **kwargs)

    return decorated


def require_locked_project_write(f):
    from functools import wraps

    @wraps(f)
    def decorated(project_id, *args, **kwargs):
        uid = session['user_id']
        project, error = get_accessible_project_or_404(project_id, uid)
        if error:
            return error
        permission_error = require_edit_access(project)
        if permission_error:
            return permission_error
        lock_error = require_project_lock(project, uid)
        if lock_error:
            return lock_error
        project_root = ensure_project_repo(project['project_path'])
        with project_write_lock(project_root):
            current_project = get_project_for_user(project_id, uid)
            current_lock_error = require_project_lock(current_project, uid)
            if current_lock_error:
                return current_lock_error
            return f(project_id, *args, **kwargs)

    return decorated


def is_markdown_path(file_path):
    return os.path.splitext(file_path)[1].lower() in MARKDOWN_EXTENSIONS


def require_markdown_path(file_path):
    if not is_markdown_path(file_path):
        return jsonify({'error': 'Only markdown files are supported here'}), 400
    return None


def project_to_api(project):
    project = dict(project)
    if project_lock_is_expired(project):
        project.update({
            'lock_owner_id': None,
            'lock_owner_username': None,
            'locked_at': None,
            'lock_expires_at': None,
        })
    project_root = ensure_project_repo(project['project_path'])
    return {
        'id': project['id'],
        'title': project['title'],
        'projectPath': project['project_path'],
        'currentCommitSha': get_project_head_commit(project_root),
        'ownerId': project['owner_id'],
        'ownerUsername': project.get('owner_username'),
        'updatedBy': project['updated_by'],
        'updatedByUsername': project.get('updated_by_username'),
        'updatedAt': project['updated_at'],
        'lockOwnerId': project.get('lock_owner_id'),
        'lockOwnerUsername': project.get('lock_owner_username'),
        'lockedAt': project.get('locked_at'),
        'lockExpiresAt': project.get('lock_expires_at'),
        'accessRole': project.get('access_role'),
        'isOwner': bool(project.get('is_owner')),
        'sharedByUsername': project.get('shared_by_username'),
    }


def get_accessible_project_or_404(project_id, user_id):
    row = get_project_for_user(project_id, user_id)
    if not row:
        return None, (jsonify({'error': 'Not found'}), 404)
    return row, None


def require_edit_access(project):
    if project['access_role'] not in ('owner', 'editor'):
        return jsonify({'error': 'Forbidden'}), 403
    return None


def require_project_lock(project, user_id):
    if not project:
        return jsonify({'error': 'Not found'}), 404
    if project.get('lock_owner_id') != user_id:
        return jsonify({'error': 'Acquire the project lock before modifying it'}), 423
    return None


def require_owner_access(project):
    if not project['is_owner']:
        return jsonify({'error': 'Forbidden'}), 403
    return None


def insert_file_version(project_id, file_path, content, message, author_id, now):
    conn = get_db()
    next_version = conn.execute(
        "SELECT COALESCE(MAX(version), 0) + 1 FROM file_versions WHERE project_id = ? AND file_path = ?",
        (project_id, file_path)
    ).fetchone()[0]
    conn.execute(
        "INSERT INTO file_versions (id, project_id, file_path, version, content, message, author_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            str(uuid.uuid4()),
            project_id,
            file_path,
            next_version,
            content,
            message,
            author_id,
            now,
        )
    )


def asset_url(project_id, file_path):
    base_path = current_app.config.get('APP_BASE_PATH', '')
    return f"{base_path}/api/projects/{project_id}/assets/{quote(file_path)}"


def replace_version_prefix(project_id, old_path, new_path):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, file_path FROM file_versions WHERE project_id = ? AND (file_path = ? OR file_path LIKE ?)",
        (project_id, old_path, f'{old_path}/%')
    ).fetchall()
    for row in rows:
        suffix = row['file_path'][len(old_path):]
        conn.execute(
            "UPDATE file_versions SET file_path = ? WHERE id = ?",
            (f'{new_path}{suffix}', row['id'])
        )


@project_bp.route('/projects', methods=['GET'])
@require_auth
def list_projects():
    conn = get_db()
    uid = session['user_id']
    rows = conn.execute(
        "SELECT p.*, "
        "owner.username AS owner_username, "
        "updater.username AS updated_by_username, "
        "locker.username AS lock_owner_username, "
        "'owner' AS access_role, "
        "1 AS is_owner, "
        "NULL AS shared_by_username "
        "FROM projects p "
        "JOIN users owner ON owner.id = p.owner_id "
        "LEFT JOIN users updater ON updater.id = p.updated_by "
        "LEFT JOIN users locker ON locker.id = p.lock_owner_id "
        "WHERE p.owner_id = ? "
        "UNION ALL "
        "SELECT p.*, "
        "owner.username AS owner_username, "
        "updater.username AS updated_by_username, "
        "locker.username AS lock_owner_username, "
        "ps.role AS access_role, "
        "0 AS is_owner, "
        "sharer.username AS shared_by_username "
        "FROM projects p "
        "JOIN project_shares ps ON ps.project_id = p.id "
        "JOIN users owner ON owner.id = p.owner_id "
        "LEFT JOIN users updater ON updater.id = p.updated_by "
        "LEFT JOIN users locker ON locker.id = p.lock_owner_id "
        "LEFT JOIN users sharer ON sharer.id = ps.shared_by "
        "WHERE ps.user_id = ? "
        "ORDER BY updated_at DESC",
        (uid, uid)
    ).fetchall()
    return jsonify([project_to_api(dict(row)) for row in rows])


@project_bp.route('/projects', methods=['POST'])
@require_auth
def create_project():
    data = request.get_json() or {}
    title = (data.get('title') or '').strip()
    if not title:
        return jsonify({'error': 'title required'}), 400
    if data.get('projectPath') is not None:
        return jsonify({'error': 'projectPath is managed by the server'}), 400

    project_id = str(uuid.uuid4())
    uid = session['user_id']
    now = datetime.now(timezone.utc).isoformat()
    project_path = default_project_path(project_id, title)
    ensure_project_repo(project_path)

    conn = get_db()
    conn.execute(
        "INSERT INTO projects (id, title, project_path, owner_id, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (project_id, title, project_path, uid, uid, now)
    )
    conn.commit()
    row = get_project_for_user(project_id, uid)
    return jsonify(project_to_api(row)), 201


@project_bp.route('/projects/<project_id>', methods=['GET'])
@require_auth
def get_project(project_id):
    row, error = get_accessible_project_or_404(project_id, session['user_id'])
    if error:
        return error
    return jsonify(project_to_api(row))


@project_bp.route('/projects/<project_id>/download', methods=['GET'])
@require_auth
def download_project(project_id):
    row, error = get_accessible_project_or_404(project_id, session['user_id'])
    if error:
        return error

    project_root = ensure_project_repo(row['project_path'])
    archive_name = f"{default_project_path(project_id, row['title']).split('/')[-1]}.tar.gz"
    archive_handle = tempfile.NamedTemporaryFile(prefix='md_review_project_', suffix='.tar.gz', delete=False)
    archive_handle.close()
    archive_path = build_project_archive(project_root, archive_handle.name, project_root.name)

    @after_this_request
    def cleanup_archive(response):
        try:
            os.unlink(archive_path)
        except FileNotFoundError:
            pass
        return response

    return send_file(archive_path, as_attachment=True, download_name=archive_name)


@project_bp.route('/projects/<project_id>', methods=['DELETE'])
@require_auth
def delete_project(project_id):
    uid = session['user_id']
    conn = get_db()
    row, error = get_accessible_project_or_404(project_id, uid)
    if error:
        return error
    permission_error = require_owner_access(row)
    if permission_error:
        return permission_error

    delete_project_root(row['project_path'])
    conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    conn.commit()
    return jsonify({'ok': True})


@project_bp.route('/projects/<project_id>/files', methods=['GET'])
@require_auth
def list_project_files(project_id):
    row, error = get_accessible_project_or_404(project_id, session['user_id'])
    if error:
        return error
    project_root = ensure_project_repo(row['project_path'])
    return jsonify({
        'items': list_project_tree(project_root),
        'currentCommitSha': get_project_head_commit(project_root),
    })


@project_bp.route('/projects/<project_id>/files', methods=['POST'])
@require_auth
@require_locked_project_write
def create_project_file(project_id):
    uid = session['user_id']
    row, error = get_accessible_project_or_404(project_id, uid)
    if error:
        return error
    permission_error = require_edit_access(row)
    if permission_error:
        return permission_error

    data = request.get_json() or {}
    try:
        file_path = normalize_project_file_path(data.get('path', ''))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    markdown_error = require_markdown_path(file_path)
    if markdown_error:
        return markdown_error

    project_root = ensure_project_repo(row['project_path'])
    abs_path = resolve_project_file(project_root, file_path)
    if abs_path.exists():
        return jsonify({'error': 'File already exists'}), 400

    content = data.get('content', '')
    now = datetime.now(timezone.utc).isoformat()
    ensure_project_file(project_root, file_path, content)
    head = git_commit_paths(project_root, [file_path], f'Save {file_path}')
    insert_file_version(project_id, file_path, content, 'Created file', uid, now)
    get_db().execute(
        "UPDATE projects SET updated_by = ?, updated_at = ? WHERE id = ?",
        (uid, now, project_id)
    )
    get_db().commit()
    return jsonify({
        'path': file_path,
        'content': content,
        'currentCommitSha': head,
    }), 201


@project_bp.route('/projects/<project_id>/files', methods=['DELETE'])
@require_auth
@require_locked_project_write
def delete_file(project_id):
    uid = session['user_id']
    row, error = get_accessible_project_or_404(project_id, uid)
    if error:
        return error
    permission_error = require_edit_access(row)
    if permission_error:
        return permission_error

    data = request.get_json() or {}
    try:
        file_path = normalize_project_file_path(data.get('path', ''))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400

    project_root = ensure_project_repo(row['project_path'])
    try:
        delete_project_file(project_root, file_path)
    except FileNotFoundError:
        return jsonify({'error': 'Not found'}), 404

    now = datetime.now(timezone.utc).isoformat()
    head = git_commit_paths(project_root, [], f'Delete {file_path}')
    get_db().execute(
        "UPDATE projects SET updated_by = ?, updated_at = ? WHERE id = ?",
        (uid, now, project_id)
    )
    get_db().commit()
    return jsonify({'ok': True, 'currentCommitSha': head})


@project_bp.route('/projects/<project_id>/files/content', methods=['GET'])
@require_auth
def get_project_file_content(project_id):
    row, error = get_accessible_project_or_404(project_id, session['user_id'])
    if error:
        return error
    try:
        file_path = normalize_project_file_path(request.args.get('path', ''))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    markdown_error = require_markdown_path(file_path)
    if markdown_error:
        return markdown_error

    project_root = ensure_project_repo(row['project_path'])
    abs_path = resolve_project_file(project_root, file_path)
    if not abs_path.exists() or not abs_path.is_file():
        return jsonify({'error': 'Not found'}), 404
    return jsonify({
        'projectId': project_id,
        'filePath': file_path,
        'content': read_project_file(project_root, file_path, ''),
        'currentCommitSha': get_project_head_commit(project_root),
    })


@project_bp.route('/projects/<project_id>/files/content', methods=['PUT'])
@require_auth
@require_locked_project_write
def save_project_file_content(project_id):
    uid = session['user_id']
    row, error = get_accessible_project_or_404(project_id, uid)
    if error:
        return error
    permission_error = require_edit_access(row)
    if permission_error:
        return permission_error

    data = request.get_json() or {}
    try:
        file_path = normalize_project_file_path(data.get('path', ''))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    markdown_error = require_markdown_path(file_path)
    if markdown_error:
        return markdown_error

    project_root = ensure_project_repo(row['project_path'])
    abs_path = resolve_project_file(project_root, file_path)
    base_commit = str(data.get('baseCommitSha') or '').strip()
    if not base_commit:
        return jsonify({'error': 'baseCommitSha required'}), 400
    current_head = get_project_head_commit(project_root)
    if base_commit != current_head:
        return jsonify({'error': 'File changed since it was loaded', 'currentCommitSha': current_head}), 409
    if not abs_path.exists():
        return jsonify({'error': 'Not found'}), 404

    proposal_id = str(data.get('proposalId') or '').strip()
    proposal_file = None
    decisions_hash = None
    if proposal_id:
        from routes.proposals import (
            get_proposal_file,
            proposal_file_review,
            proposal_row,
            refresh_stale_status,
            decision_map,
        )
        proposal = proposal_row(proposal_id, project_id)
        if not proposal:
            return jsonify({'error': 'Proposal not found'}), 404
        proposal = refresh_stale_status(proposal, project_root)
        if proposal['status'] != 'pending':
            return jsonify({'error': f"Proposal is {proposal['status']}", 'code': proposal['status']}), 409
        proposal_file = get_proposal_file(proposal_id, file_path)
        if not proposal_file:
            return jsonify({'error': 'File is not part of this proposal'}), 400
        decisions_hash = proposal_file_review(
            proposal_file, decision_map(proposal_id)
        )['decisionsHash']

    old_content = read_project_file(project_root, file_path, '')
    content = data.get('content', old_content)
    if not isinstance(content, str):
        return jsonify({'error': 'content must be text'}), 400
    now = datetime.now(timezone.utc).isoformat()
    head = current_head
    changed = content != old_content
    if changed:
        write_project_file(project_root, file_path, content)
        head = git_commit_paths(project_root, [file_path], f'Save {file_path}')
        insert_file_version(project_id, file_path, content, 'Saved file', uid, now)
        get_db().execute(
            'UPDATE projects SET updated_by = ?, updated_at = ? WHERE id = ?',
            (uid, now, project_id)
        )

    if proposal_file:
        get_db().execute(
            'UPDATE revision_proposal_files SET applied_decisions_hash = ?, '
            'applied_commit_sha = ?, applied_at = ? '
            'WHERE proposal_id = ? AND file_path = ?',
            (decisions_hash, head, now, proposal_id, file_path),
        )
        get_db().execute(
            'UPDATE revision_proposals SET base_commit_sha = ?, stale_reason = NULL '
            "WHERE id = ? AND project_id = ? AND status = 'pending'",
            (head, proposal_id, project_id),
        )
    get_db().commit()

    response = {
        'projectId': project_id,
        'filePath': file_path,
        'content': content,
        'currentCommitSha': head,
        'versionCreated': changed,
    }
    if proposal_file:
        from routes.proposals import proposal_detail, proposal_row
        detail = proposal_detail(proposal_row(proposal_id, project_id))
        applied_file = next(file for file in detail['files'] if file['filePath'] == file_path)
        response['proposalReview'] = {
            'proposalId': proposal_id,
            'filePath': file_path,
            'applied': applied_file['applied'],
            'needsSave': applied_file['needsSave'],
            'canClose': detail['review']['canClose'],
        }
    return jsonify(response)


@project_bp.route('/projects/<project_id>/assets', methods=['POST'])
@require_auth
@require_locked_project_write
def upload_project_asset(project_id):
    uid = session['user_id']
    row, error = get_accessible_project_or_404(project_id, uid)
    if error:
        return error
    permission_error = require_edit_access(row)
    if permission_error:
        return permission_error

    upload = request.files.get('file')
    if not upload or not upload.filename:
        return jsonify({'error': 'file required'}), 400

    target_dir = (request.form.get('path') or '').strip()
    project_root = ensure_project_repo(row['project_path'])
    safe_name = sanitize_asset_filename(upload.filename)
    try:
        if target_dir:
            target_dir = normalize_project_file_path(target_dir)
            target_path = f'{target_dir}/{safe_name}'
        else:
            target_path = safe_name
        abs_path = resolve_project_file(project_root, target_path)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400

    abs_path.parent.mkdir(parents=True, exist_ok=True)
    upload.save(abs_path)
    now = datetime.now(timezone.utc).isoformat()
    head = git_commit_paths(project_root, [target_path], f'Upload {target_path}')
    get_db().execute(
        "UPDATE projects SET updated_by = ?, updated_at = ? WHERE id = ?",
        (uid, now, project_id)
    )
    get_db().commit()
    return jsonify({
        'filename': abs_path.name,
        'path': target_path,
        'url': asset_url(project_id, target_path),
        'currentCommitSha': head,
    }), 201


@project_bp.route('/projects/<project_id>/assets/<path:file_path>', methods=['GET'])
@require_auth
def get_project_asset(project_id, file_path):
    row, error = get_accessible_project_or_404(project_id, session['user_id'])
    if error:
        return error
    project_root = ensure_project_repo(row['project_path'])
    try:
        abs_path = resolve_project_file(project_root, file_path)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not abs_path.exists() or not abs_path.is_file():
        return jsonify({'error': 'Asset not found'}), 404
    return send_file(abs_path)


@project_bp.route('/projects/<project_id>/rename', methods=['POST'])
@require_auth
@require_locked_project_write
def rename_file(project_id):
    uid = session['user_id']
    row, error = get_accessible_project_or_404(project_id, uid)
    if error:
        return error
    permission_error = require_edit_access(row)
    if permission_error:
        return permission_error

    data = request.get_json() or {}
    try:
        old_path = normalize_project_file_path(data.get('oldPath', ''))
        new_path = normalize_project_file_path(data.get('newPath', ''))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400

    project_root = ensure_project_repo(row['project_path'])
    old_comment_store = get_comment_file_store_dir(project_root, old_path)
    new_comment_store = get_comment_file_store_dir(project_root, new_path)
    if old_comment_store.exists() and new_comment_store.exists():
        return jsonify({'error': 'Comment history already exists at destination'}), 409
    try:
        rename_project_path(project_root, old_path, new_path)
    except FileNotFoundError:
        return jsonify({'error': 'Not found'}), 404
    except FileExistsError:
        return jsonify({'error': 'Destination already exists'}), 409

    try:
        rename_comment_store_path(project_root, old_path, new_path)
    except Exception:
        rename_project_path(project_root, new_path, old_path)
        raise

    replace_version_prefix(project_id, old_path, new_path)
    now = datetime.now(timezone.utc).isoformat()
    head = git_commit_paths(project_root, [], f'Rename {old_path} to {new_path}')
    get_db().execute(
        "UPDATE projects SET updated_by = ?, updated_at = ? WHERE id = ?",
        (uid, now, project_id)
    )
    get_db().commit()
    return jsonify({'ok': True, 'currentCommitSha': head})


def lock_conflict_response(project_id, uid):
    current = get_project_for_user(project_id, uid)
    return jsonify({
        'error': 'Project is locked by another user',
        'code': 'project_locked',
        'lockOwnerId': current.get('lock_owner_id') if current else None,
        'lockOwnerUsername': current.get('lock_owner_username') if current else None,
        'lockExpiresAt': current.get('lock_expires_at') if current else None,
    }), 423


@project_bp.route('/projects/<project_id>/lock', methods=['POST'])
@require_auth
def lock_project(project_id):
    uid = session['user_id']
    row, error = get_accessible_project_or_404(project_id, uid)
    if error:
        return error
    permission_error = require_edit_access(row)
    if permission_error:
        return permission_error
    _, lock_error = acquire_project_lock(project_id, uid)
    if lock_error:
        return lock_conflict_response(project_id, uid)
    return jsonify(project_to_api(get_project_for_user(project_id, uid)))


@project_bp.route('/projects/<project_id>/lock/heartbeat', methods=['POST'])
@require_auth
def heartbeat_project_lock(project_id):
    uid = session['user_id']
    row, error = get_accessible_project_or_404(project_id, uid)
    if error:
        return error
    permission_error = require_edit_access(row)
    if permission_error:
        return permission_error
    if row.get('lock_owner_id') != uid:
        return jsonify({'error': 'You do not own this lock'}), 423
    _, lock_error = refresh_project_lock(project_id, uid)
    if lock_error:
        return lock_conflict_response(project_id, uid)
    return jsonify(project_to_api(get_project_for_user(project_id, uid)))


@project_bp.route('/projects/<project_id>/lock', methods=['DELETE'])
@require_auth
def unlock_project(project_id):
    uid = session['user_id']
    row, error = get_accessible_project_or_404(project_id, uid)
    if error:
        return error
    permission_error = require_edit_access(row)
    if permission_error:
        return permission_error
    if row.get('lock_owner_id') not in (None, uid):
        return jsonify({'error': 'You do not own this lock'}), 403
    if row.get('lock_owner_id') == uid:
        release_project_lock(project_id, uid)
    return jsonify({'ok': True})


@project_bp.route('/projects/<project_id>/shares', methods=['GET'])
@require_auth
def list_project_shares(project_id):
    row, error = get_accessible_project_or_404(project_id, session['user_id'])
    if error:
        return error
    permission_error = require_owner_access(row)
    if permission_error:
        return permission_error

    shares = get_db().execute(
        "SELECT ps.project_id, ps.user_id, u.username, ps.role, ps.shared_by, "
        "sharer.username AS shared_by_username, ps.created_at "
        "FROM project_shares ps "
        "JOIN users u ON u.id = ps.user_id "
        "JOIN users sharer ON sharer.id = ps.shared_by "
        "WHERE ps.project_id = ? "
        "ORDER BY u.username ASC",
        (project_id,)
    ).fetchall()
    return jsonify([
        {
            'projectId': share['project_id'],
            'userId': share['user_id'],
            'username': share['username'],
            'role': share['role'],
            'sharedBy': share['shared_by'],
            'sharedByUsername': share['shared_by_username'],
            'createdAt': share['created_at'],
        }
        for share in shares
    ])


@project_bp.route('/projects/<project_id>/shares', methods=['POST'])
@require_auth
def create_or_update_share(project_id):
    uid = session['user_id']
    row, error = get_accessible_project_or_404(project_id, uid)
    if error:
        return error
    permission_error = require_owner_access(row)
    if permission_error:
        return permission_error

    data = request.get_json() or {}
    username = (data.get('username') or '').strip()
    role = (data.get('role') or '').strip().lower()
    if not username:
        return jsonify({'error': 'username required'}), 400
    if role not in SHARE_ROLES:
        return jsonify({'error': 'role must be viewer or editor'}), 400

    conn = get_db()
    user_row = conn.execute("SELECT id, username FROM users WHERE username = ?", (username,)).fetchone()
    if not user_row:
        return jsonify({'error': 'User not found'}), 404
    if user_row['id'] == row['owner_id']:
        return jsonify({'error': 'Owner already has access'}), 400

    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO project_shares (project_id, user_id, role, shared_by, created_at) "
        "VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(project_id, user_id) DO UPDATE SET "
        "role = excluded.role, shared_by = excluded.shared_by, created_at = excluded.created_at",
        (project_id, user_row['id'], role, uid, now)
    )
    conn.commit()

    share = conn.execute(
        "SELECT ps.project_id, ps.user_id, u.username, ps.role, ps.shared_by, "
        "sharer.username AS shared_by_username, ps.created_at "
        "FROM project_shares ps "
        "JOIN users u ON u.id = ps.user_id "
        "JOIN users sharer ON sharer.id = ps.shared_by "
        "WHERE ps.project_id = ? AND ps.user_id = ?",
        (project_id, user_row['id'])
    ).fetchone()
    return jsonify({
        'projectId': share['project_id'],
        'userId': share['user_id'],
        'username': share['username'],
        'role': share['role'],
        'sharedBy': share['shared_by'],
        'sharedByUsername': share['shared_by_username'],
        'createdAt': share['created_at'],
    })


@project_bp.route('/projects/<project_id>/shares/<user_id>', methods=['DELETE'])
@require_auth
def delete_share(project_id, user_id):
    uid = session['user_id']
    row, error = get_accessible_project_or_404(project_id, uid)
    if error:
        return error
    permission_error = require_owner_access(row)
    if permission_error:
        return permission_error

    deleted = get_db().execute(
        "DELETE FROM project_shares WHERE project_id = ? AND user_id = ?",
        (project_id, user_id)
    )
    get_db().commit()
    if deleted.rowcount == 0:
        return jsonify({'error': 'Share not found'}), 404
    return jsonify({'ok': True})
