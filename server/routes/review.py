import uuid
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request, session

from models import get_db, get_project_for_user, user_can_edit_project
from utils.diff import apply_diff_decisions, compute_diff
from utils.repo_storage import (
    git_commit_paths,
    load_applicable_comment_stores,
    load_comment_store,
    list_applicable_comment_store_commits,
    normalize_project_file_path,
    normalize_project_commit,
    project_write_lock,
    read_project_file,
    resolve_project_root,
    save_comment_store,
    write_project_file,
)


review_bp = Blueprint('review', __name__)
PROPOSAL_VERSION_PREFIX = 'proposal:'


def proposal_version_id(proposal_id):
    return f'{PROPOSAL_VERSION_PREFIX}{proposal_id}'


def load_version_candidate(conn, project_id, file_path, version_id):
    if version_id.startswith(PROPOSAL_VERSION_PREFIX):
        proposal_id = version_id[len(PROPOSAL_VERSION_PREFIX):]
        row = conn.execute(
            "SELECT rp.id AS proposal_id, rp.project_id, rpf.file_path, "
            "rpf.base_content, rpf.proposed_content AS content, rp.title AS message, rp.author_id, "
            "rp.created_at, rp.status, rp.base_commit_sha, u.username AS author_name "
            "FROM revision_proposals rp "
            "JOIN revision_proposal_files rpf ON rpf.proposal_id = rp.id "
            "JOIN users u ON u.id = rp.author_id "
            "WHERE rp.id = ? AND rp.project_id = ? AND rpf.file_path = ?",
            (proposal_id, project_id, file_path)
        ).fetchone()
        if not row or row['status'] != 'pending':
            return None
        candidate = dict(row)
        candidate.update({
            'id': version_id,
            'version': None,
            'kind': 'proposal',
        })
        return candidate

    row = conn.execute(
        "SELECT fv.*, u.username AS author_name FROM file_versions fv "
        "JOIN users u ON u.id = fv.author_id "
        "WHERE fv.id = ? AND fv.project_id = ? AND fv.file_path = ?",
        (version_id, project_id, file_path)
    ).fetchone()
    if not row:
        return None
    candidate = dict(row)
    candidate.update({
        'kind': 'published',
        'status': 'published',
        'proposal_id': None,
        'base_commit_sha': None,
    })
    return candidate


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


def require_project_lock(project_id, user_id):
    project = get_project_for_user(project_id, user_id)
    if not project:
        return None, (jsonify({'error': 'Not found'}), 404)
    if project['access_role'] not in ('owner', 'editor'):
        return None, (jsonify({'error': 'Forbidden'}), 403)
    if project.get('lock_owner_id') != user_id:
        return None, (jsonify({'error': 'Take the project lock first.'}), 423)
    return project, None


def require_locked_project_write(f):
    from functools import wraps

    @wraps(f)
    def decorated(project_id, *args, **kwargs):
        uid = session['user_id']
        project, error = require_project_lock(project_id, uid)
        if error:
            return error
        project_root = resolve_project_root(project['project_path'])
        with project_write_lock(project_root):
            _, current_error = require_project_lock(project_id, uid)
            if current_error:
                return current_error
            return f(project_id, *args, **kwargs)

    return decorated


def normalize_comment_context(data):
    if not data or not data.get('projectId'):
        return None, (jsonify({'error': 'projectId required'}), 400)
    if not data.get('commitSha'):
        return None, (jsonify({'error': 'commitSha required'}), 400)
    if not data.get('filePath'):
        return None, (jsonify({'error': 'filePath required'}), 400)
    project = get_project_for_user(data['projectId'], session['user_id'])
    if not project:
        return None, (jsonify({'error': 'Not found'}), 404)
    project_root = resolve_project_root(project['project_path'])
    try:
        file_path = normalize_project_file_path(data['filePath'])
        commit_sha = normalize_project_commit(project_root, data['commitSha'])
    except ValueError as exc:
        return None, (jsonify({'error': str(exc)}), 400)
    return {
        'projectId': data['projectId'],
        'projectRoot': project_root,
        'commitSha': commit_sha,
        'filePath': file_path,
    }, None


def require_locked_comment_write(f):
    from functools import wraps

    @wraps(f)
    def decorated(*args, **kwargs):
        data = request.get_json(silent=True) or {}
        context, error = normalize_comment_context(data)
        if error:
            return error
        with project_write_lock(context['projectRoot']):
            return f(*args, **kwargs)

    return decorated


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

    conn = get_db()
    published_rows = conn.execute(
        "SELECT fv.id, fv.project_id, fv.file_path, fv.version, fv.content, fv.message, "
        "fv.author_id, fv.created_at, u.username AS author_name "
        "FROM file_versions fv "
        "JOIN users u ON fv.author_id = u.id "
        "WHERE fv.project_id = ? AND fv.file_path = ? "
        "ORDER BY fv.version DESC",
        (project_id, file_path)
    ).fetchall()
    published = []
    published_content_ids = {}
    for row in published_rows:
        item = dict(row)
        published_content_ids.setdefault(item.pop('content'), item['id'])
        item.update({'kind': 'published', 'status': 'published', 'proposalId': None})
        published.append(item)

    proposal_rows = conn.execute(
        "SELECT rp.id AS proposal_id, rp.project_id, rpf.file_path, rpf.base_content, "
        "rp.title AS message, rp.author_id, rp.created_at, rp.status, "
        "rp.base_commit_sha, u.username AS author_name "
        "FROM revision_proposals rp "
        "JOIN revision_proposal_files rpf ON rpf.proposal_id = rp.id "
        "JOIN users u ON u.id = rp.author_id "
        "WHERE rp.project_id = ? AND rpf.file_path = ? AND rp.status = 'pending' "
        "ORDER BY rp.created_at DESC",
        (project_id, file_path)
    ).fetchall()
    project = get_project_for_user(project_id, session['user_id'])
    project_root = resolve_project_root(project['project_path'])
    from routes.proposals import proposal_row, refresh_stale_status

    proposals = []
    for row in proposal_rows:
        current = proposal_row(row['proposal_id'], project_id)
        current = refresh_stale_status(current, project_root)
        if current['status'] != 'pending':
            continue
        item = dict(row)
        base_content = item.pop('base_content')
        item.update({
            'id': proposal_version_id(row['proposal_id']),
            'version': None,
            'kind': 'proposal',
            'proposalId': row['proposal_id'],
            'baseVersionId': published_content_ids.get(base_content),
        })
        proposals.append(item)
    return jsonify(proposals + published)


@review_bp.route('/projects/<project_id>/files/versions/<path:version_id>', methods=['GET'])
@require_auth
def get_version(project_id, version_id):
    access_error = require_project_access(project_id, session['user_id'])
    if access_error:
        return access_error
    file_path = request.args.get('path', '')
    if version_id.startswith(PROPOSAL_VERSION_PREFIX):
        try:
            file_path = normalize_project_file_path(file_path)
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400
        row = load_version_candidate(get_db(), project_id, file_path, version_id)
        if row:
            project = get_project_for_user(project_id, session['user_id'])
            from routes.proposals import proposal_row, refresh_stale_status
            current = refresh_stale_status(
                proposal_row(row['proposal_id'], project_id),
                resolve_project_root(project['project_path']),
            )
            if current['status'] != 'pending':
                row = None
    else:
        row = get_db().execute(
            "SELECT fv.id, fv.project_id, fv.file_path, fv.version, fv.content, fv.message, "
            "fv.author_id, fv.created_at, u.username AS author_name "
            "FROM file_versions fv JOIN users u ON u.id = fv.author_id "
            "WHERE fv.id = ? AND fv.project_id = ?",
            (version_id, project_id)
        ).fetchone()
        row = dict(row) if row else None
        if row:
            row.update({'kind': 'published', 'status': 'published', 'proposalId': None})
    if not row:
        return jsonify({'error': 'Version not found'}), 404
    if row.get('kind') == 'proposal':
        row['proposalId'] = row.pop('proposal_id')
        row['baseCommitSha'] = row.pop('base_commit_sha')
    return jsonify(row)


@review_bp.route('/projects/<project_id>/files/compare', methods=['POST'])
@require_auth
def compare_versions(project_id):
    uid = session['user_id']
    access_error = require_project_access(project_id, uid)
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
    va = load_version_candidate(conn, project_id, file_path, version_a)
    vb = load_version_candidate(conn, project_id, file_path, version_b)
    if not va or not vb:
        return jsonify({'error': 'Version not found'}), 404
    if va['kind'] == 'proposal':
        return jsonify({'error': 'A proposal can only be compared as the candidate version'}), 400

    proposal = vb if vb['kind'] == 'proposal' else None
    if proposal:
        project = get_project_for_user(project_id, uid)
        from routes.proposals import proposal_row, refresh_stale_status
        current = refresh_stale_status(
            proposal_row(proposal['proposal_id'], project_id),
            resolve_project_root(project['project_path']),
        )
        if current['status'] != 'pending':
            return jsonify({'error': f"Proposal is {current['status']}", 'code': current['status']}), 409

    proposal_base_matches = bool(proposal and va['content'] == proposal['base_content'])
    diff_rows = compute_diff(va['content'], vb['content'])
    decisions = {}
    if proposal_base_matches:
        decisions = {
            row['item_id']: row['decision']
            for row in conn.execute(
                "SELECT item_id, decision FROM revision_proposal_decisions "
                "WHERE proposal_id = ? AND item_kind = 'diff' AND file_path = ?",
                (proposal['proposal_id'], file_path)
            ).fetchall()
        }
    label_a = f"v{va['version']}" if va['kind'] == 'published' else 'Proposed version'
    label_b = f"v{vb['version']}" if vb['kind'] == 'published' else f"Proposed by {vb['author_name']}"
    return jsonify({
        'diff': diff_rows,
        'projectId': project_id,
        'filePath': file_path,
        'versionA': va['version'],
        'versionAId': va['id'],
        'versionB': vb['version'],
        'versionBId': vb['id'],
        'createdAtA': va['created_at'],
        'createdAtB': vb['created_at'],
        'labelA': label_a,
        'labelB': label_b,
        'proposalId': proposal['proposal_id'] if proposal else None,
        'proposalAuthorId': proposal['author_id'] if proposal else None,
        'proposalAuthorUsername': proposal['author_name'] if proposal else None,
        'proposalDecisions': decisions,
        'proposalBaseMatches': proposal_base_matches if proposal else None,
        'reviewerCanDecide': bool(
            proposal_base_matches
            and proposal['author_id'] != uid
            and user_can_edit_project(project_id, uid)
        ),
    })


@review_bp.route('/projects/<project_id>/files/apply-diff-chunk', methods=['POST'])
@require_auth
def apply_diff_chunk_route(project_id):
    uid = session['user_id']
    project, access_error = require_project_lock(project_id, uid)
    if access_error:
        return access_error

    data = request.get_json() or {}
    version_a = data.get('versionA')
    version_b = data.get('versionB')
    current_content = data.get('currentContent')
    row_id = data.get('rowId')
    chunk_id = data.get('chunkId')
    decision = data.get('decision')
    decisions = data.get('decisions')

    try:
        file_path = normalize_project_file_path(data.get('path', ''))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400

    if not version_a or not version_b:
        return jsonify({'error': 'versionA and versionB required'}), 400
    if current_content is None:
        return jsonify({'error': 'currentContent required'}), 400
    if not row_id or not chunk_id or decision not in {'accept', 'refuse'}:
        return jsonify({'error': 'rowId, chunkId, and decision required'}), 400

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

    decision_list = []
    if isinstance(decisions, list):
        for item in decisions:
            if not isinstance(item, dict):
                continue
            if item.get('rowId') and item.get('chunkId') and item.get('decision') in {'accept', 'refuse'}:
                decision_list.append({
                    'rowId': item['rowId'],
                    'chunkId': item['chunkId'],
                    'decision': item['decision'],
                })

    if not any(item['rowId'] == row_id and item['chunkId'] == chunk_id for item in decision_list):
        decision_list.append({
            'rowId': row_id,
            'chunkId': chunk_id,
            'decision': decision,
        })

    try:
        applied = apply_diff_decisions(va['content'], vb['content'], current_content, decision_list)
    except KeyError as exc:
        return jsonify({'error': str(exc)}), 404
    except RuntimeError as exc:
        return jsonify({
            'error': str(exc),
            'conflict': True,
            'rowId': row_id,
            'chunkId': chunk_id,
            'decision': decision,
        }), 409
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400

    return jsonify({
        'projectId': project_id,
        'filePath': file_path,
        'content': applied['content'],
        'applied': True,
        'decision': decision,
        'rowId': row_id,
        'chunkId': chunk_id,
        'diff': applied['diff'],
        'versionA': va['version'],
        'versionAId': va['id'],
        'versionB': vb['version'],
        'versionBId': vb['id'],
        'lockOwnerId': project.get('lock_owner_id'),
    })


@review_bp.route('/projects/<project_id>/files/versions/<version_id>/revert', methods=['POST'])
@require_auth
@require_locked_project_write
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
        "INSERT INTO file_versions (id, project_id, file_path, version, content, message, author_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            str(uuid.uuid4()),
            project_id,
            version['file_path'],
            next_version,
            version['content'],
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
@require_locked_comment_write
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
@require_locked_comment_write
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
    try:
        stores = load_applicable_comment_stores(project_root, file_path, commit_sha)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
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
@require_locked_comment_write
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
@require_locked_comment_write
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
