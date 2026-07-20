import copy
import hashlib
import json
import uuid
from datetime import datetime, timezone
from functools import wraps

from flask import Blueprint, jsonify, request, session

from models import (
    acquire_project_lock,
    get_db,
    get_project_for_user,
    release_project_lock,
    user_can_edit_project,
)
from utils.diff import apply_diff_decisions, compute_diff
from utils.repo_storage import (
    get_project_head_commit,
    git_commit_paths,
    load_applicable_comment_stores,
    normalize_project_file_path,
    project_write_lock,
    read_project_file,
    reset_project_to_commit,
    resolve_project_file,
    resolve_project_root,
    save_comment_store,
    write_project_file,
)


proposal_bp = Blueprint('proposals', __name__)
MARKDOWN_EXTENSIONS = ('.md', '.markdown')
PROPOSAL_STATUSES = {'pending', 'accepted', 'rejected', 'stale'}
DECISIONS = {'accept', 'refuse'}


def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Not authenticated'}), 401
        return f(*args, **kwargs)
    return decorated


def with_proposal_project_lock(f):
    @wraps(f)
    def decorated(project_id, proposal_id, *args, **kwargs):
        project, error = get_project_or_error(project_id, session['user_id'])
        if error:
            return error
        with project_write_lock(resolve_project_root(project['project_path'])):
            return f(project_id, proposal_id, *args, **kwargs)
    return decorated


def get_project_or_error(project_id, user_id):
    project = get_project_for_user(project_id, user_id)
    if not project:
        return None, (jsonify({'error': 'Not found'}), 404)
    return project, None


def require_editor(project_id, user_id):
    project, error = get_project_or_error(project_id, user_id)
    if error:
        return None, error
    if not user_can_edit_project(project_id, user_id):
        return None, (jsonify({'error': 'Forbidden'}), 403)
    return project, None


def lock_conflict(project_id, user_id):
    project = get_project_for_user(project_id, user_id)
    return jsonify({
        'error': 'Project is locked by another user',
        'code': 'project_locked',
        'lockOwnerId': project.get('lock_owner_id') if project else None,
        'lockOwnerUsername': project.get('lock_owner_username') if project else None,
        'lockExpiresAt': project.get('lock_expires_at') if project else None,
    }), 423


def acquire_temporary_lease(project_id, user_id):
    project = get_project_for_user(project_id, user_id)
    already_owned = bool(project and project.get('lock_owner_id') == user_id)
    _, error = acquire_project_lock(project_id, user_id)
    return (not already_owned), error


def proposal_row(proposal_id, project_id=None):
    params = [proposal_id]
    where = 'rp.id = ?'
    if project_id is not None:
        where += ' AND rp.project_id = ?'
        params.append(project_id)
    return get_db().execute(
        "SELECT rp.*, author.username AS author_username, reviewer.username AS reviewer_username "
        "FROM revision_proposals rp "
        "JOIN users author ON author.id = rp.author_id "
        "LEFT JOIN users reviewer ON reviewer.id = rp.decided_by "
        f"WHERE {where}",
        params
    ).fetchone()


def serialize_proposal(row):
    return {
        'id': row['id'],
        'projectId': row['project_id'],
        'authorId': row['author_id'],
        'authorUsername': row['author_username'],
        'title': row['title'],
        'summary': row['summary'],
        'baseCommitSha': row['base_commit_sha'],
        'status': row['status'],
        'staleReason': row['stale_reason'],
        'createdAt': row['created_at'],
        'decidedBy': row['decided_by'],
        'reviewerUsername': row['reviewer_username'],
        'decidedAt': row['decided_at'],
        'appliedCommitSha': row['applied_commit_sha'],
    }


def thread_fingerprint(thread):
    return hashlib.sha256(
        json.dumps(thread, sort_keys=True, separators=(',', ':')).encode('utf-8')
    ).hexdigest()


def find_thread(project_root, file_path, commit_sha, thread_id):
    for store in load_applicable_comment_stores(project_root, file_path, commit_sha):
        for thread in store.get('threads', []):
            if thread.get('id') == thread_id:
                return store, thread
    return None, None


def actionable_chunks(diff_rows):
    items = []
    for row in diff_rows:
        for chunk in row.get('chunks', []):
            kind = chunk.get('kind')
            if kind in ('line-add', 'line-remove') or (kind == 'replace' and row.get('type') == 'added'):
                item_id = f"{row['rowId']}::{chunk['chunkId']}"
                chunk['itemId'] = item_id
                items.append({
                    'itemId': item_id,
                    'rowId': row['rowId'],
                    'chunkId': chunk['chunkId'],
                })
    return items


def load_proposal_files(proposal_id):
    return [
        dict(row) for row in get_db().execute(
            'SELECT proposal_id, file_path, base_content, proposed_content '
            'FROM revision_proposal_files WHERE proposal_id = ? ORDER BY file_path',
            (proposal_id,)
        ).fetchall()
    ]


def load_comment_actions(proposal_id):
    return [
        dict(row) for row in get_db().execute(
            'SELECT * FROM revision_proposal_comment_actions '
            'WHERE proposal_id = ? ORDER BY file_path, id',
            (proposal_id,)
        ).fetchall()
    ]


def load_decisions(proposal_id):
    return [
        dict(row) for row in get_db().execute(
            'SELECT * FROM revision_proposal_decisions WHERE proposal_id = ?',
            (proposal_id,)
        ).fetchall()
    ]


def stale_reason(row, project_root):
    if get_project_head_commit(project_root) != row['base_commit_sha']:
        return 'Project changed after this proposal was created.'
    for action in load_comment_actions(row['id']):
        try:
            store, thread = find_thread(
                project_root,
                action['file_path'],
                action['source_commit_sha'],
                action['thread_id'],
            )
        except ValueError:
            return 'A referenced comment thread is no longer available.'
        if not store or not thread or thread_fingerprint(thread) != action['source_fingerprint']:
            return 'A referenced comment thread changed after this proposal was created.'
    return None


def refresh_stale_status(row, project_root):
    if row['status'] != 'pending':
        return row
    reason = stale_reason(row, project_root)
    if not reason:
        return row
    conn = get_db()
    conn.execute(
        "UPDATE revision_proposals SET status = 'stale', stale_reason = ? WHERE id = ? AND status = 'pending'",
        (reason, row['id'])
    )
    conn.commit()
    return proposal_row(row['id'])


def required_items(proposal_id):
    required = set()
    for item in load_proposal_files(proposal_id):
        diff = compute_diff(item['base_content'], item['proposed_content'])
        for chunk in actionable_chunks(diff):
            required.add(('diff', item['file_path'], chunk['itemId']))
    for action in load_comment_actions(proposal_id):
        required.add(('comment', '', action['id']))
    return required


def proposal_detail(row):
    decisions = {
        (item['item_kind'], item['file_path'], item['item_id']): item
        for item in load_decisions(row['id'])
    }
    files = []
    for item in load_proposal_files(row['id']):
        diff = compute_diff(item['base_content'], item['proposed_content'])
        chunks = actionable_chunks(diff)
        for chunk in chunks:
            saved = decisions.get(('diff', item['file_path'], chunk['itemId']))
            chunk['decision'] = saved['decision'] if saved else None
        files.append({
            'filePath': item['file_path'],
            'diff': diff,
            'reviewItems': chunks,
        })
    actions = []
    for action in load_comment_actions(row['id']):
        saved = decisions.get(('comment', '', action['id']))
        actions.append({
            'id': action['id'],
            'threadId': action['thread_id'],
            'filePath': action['file_path'],
            'sourceCommitSha': action['source_commit_sha'],
            'actionType': action['action_type'],
            'body': action['body'],
            'decision': saved['decision'] if saved else None,
        })
    required = required_items(row['id'])
    decided = {key for key in decisions if key in required}
    accepted = sum(1 for key, value in decisions.items() if key in required and value['decision'] == 'accept')
    detail = serialize_proposal(row)
    detail.update({
        'files': files,
        'commentActions': actions,
        'review': {
            'required': len(required),
            'decided': len(decided),
            'accepted': accepted,
            'complete': bool(required) and len(required) == len(decided),
            'canPublish': bool(required) and len(required) == len(decided) and accepted > 0,
        },
    })
    return detail


@proposal_bp.route('/projects/<project_id>/proposals', methods=['GET'])
@require_auth
def list_proposals(project_id):
    project, error = get_project_or_error(project_id, session['user_id'])
    if error:
        return error
    status = (request.args.get('status') or '').strip()
    params = [project_id]
    where = 'rp.project_id = ?'
    if status:
        if status not in PROPOSAL_STATUSES:
            return jsonify({'error': 'Invalid proposal status'}), 400
        where += ' AND rp.status = ?'
        params.append(status)
    rows = get_db().execute(
        "SELECT rp.*, author.username AS author_username, reviewer.username AS reviewer_username "
        "FROM revision_proposals rp "
        "JOIN users author ON author.id = rp.author_id "
        "LEFT JOIN users reviewer ON reviewer.id = rp.decided_by "
        f"WHERE {where} ORDER BY rp.created_at DESC",
        params
    ).fetchall()
    project_root = resolve_project_root(project['project_path'])
    result = []
    for row in rows:
        row = refresh_stale_status(row, project_root)
        result.append(serialize_proposal(row))
    return jsonify(result)


@proposal_bp.route('/projects/<project_id>/proposals', methods=['POST'])
@require_auth
def create_proposal(project_id):
    uid = session['user_id']
    project, error = require_editor(project_id, uid)
    if error:
        return error
    data = request.get_json() or {}
    title = (data.get('title') or '').strip()
    summary = (data.get('summary') or '').strip()
    base_commit = (data.get('baseCommitSha') or '').strip()
    file_changes = data.get('files') or []
    comment_actions = data.get('commentActions') or []
    if not title:
        return jsonify({'error': 'title required'}), 400
    if not base_commit:
        return jsonify({'error': 'baseCommitSha required'}), 400
    if not isinstance(file_changes, list) or not isinstance(comment_actions, list):
        return jsonify({'error': 'files and commentActions must be lists'}), 400
    if not file_changes and not comment_actions:
        return jsonify({'error': 'At least one file change or comment action is required'}), 400

    release_after, lock_error = acquire_temporary_lease(project_id, uid)
    if lock_error:
        return lock_conflict(project_id, uid)

    project_root = resolve_project_root(project['project_path'])
    try:
        with project_write_lock(project_root):
            if get_project_head_commit(project_root) != base_commit:
                return jsonify({'error': 'Project changed since Codex loaded it', 'code': 'stale_base'}), 409

            normalized_files = []
            seen_paths = set()
            for item in file_changes:
                if not isinstance(item, dict):
                    return jsonify({'error': 'Each file change must be an object'}), 400
                try:
                    file_path = normalize_project_file_path(item.get('path', ''))
                except ValueError as exc:
                    return jsonify({'error': str(exc)}), 400
                if not file_path.lower().endswith(MARKDOWN_EXTENSIONS):
                    return jsonify({'error': 'Proposals may edit existing Markdown files only'}), 400
                if file_path in seen_paths:
                    return jsonify({'error': f'Duplicate proposal path: {file_path}'}), 400
                seen_paths.add(file_path)
                abs_path = resolve_project_file(project_root, file_path)
                if not abs_path.is_file():
                    return jsonify({'error': f'File not found: {file_path}'}), 404
                proposed_content = item.get('content')
                if not isinstance(proposed_content, str):
                    return jsonify({'error': f'content must be text for {file_path}'}), 400
                base_content = read_project_file(project_root, file_path, '')
                if proposed_content == base_content:
                    return jsonify({'error': f'No content change for {file_path}'}), 400
                if not actionable_chunks(compute_diff(base_content, proposed_content)):
                    return jsonify({'error': f'No reviewable diff for {file_path}'}), 400
                normalized_files.append((file_path, base_content, proposed_content))

            normalized_actions = []
            seen_actions = set()
            for item in comment_actions:
                if not isinstance(item, dict):
                    return jsonify({'error': 'Each comment action must be an object'}), 400
                action_type = (item.get('action') or '').strip().lower()
                if action_type not in ('reply', 'resolve'):
                    return jsonify({'error': 'Comment action must be reply or resolve'}), 400
                body = (item.get('body') or '').strip()
                if action_type == 'reply' and not body:
                    return jsonify({'error': 'Reply actions require body'}), 400
                try:
                    file_path = normalize_project_file_path(item.get('filePath', ''))
                except ValueError as exc:
                    return jsonify({'error': str(exc)}), 400
                commit_sha = (item.get('commitSha') or base_commit).strip()
                thread_id = (item.get('threadId') or '').strip()
                if not thread_id:
                    return jsonify({'error': 'Comment action threadId required'}), 400
                key = (thread_id, action_type)
                if key in seen_actions:
                    return jsonify({'error': f'Duplicate {action_type} action for thread {thread_id}'}), 400
                seen_actions.add(key)
                try:
                    store, thread = find_thread(project_root, file_path, commit_sha, thread_id)
                except ValueError as exc:
                    return jsonify({'error': str(exc)}), 400
                if not store or not thread:
                    return jsonify({'error': f'Comment thread not found: {thread_id}'}), 404
                if action_type == 'resolve' and thread.get('resolved'):
                    return jsonify({'error': f'Comment thread already resolved: {thread_id}'}), 409
                normalized_actions.append({
                    'id': str(uuid.uuid4()),
                    'thread_id': thread_id,
                    'file_path': file_path,
                    'source_commit_sha': store.get('commitSha', commit_sha),
                    'source_fingerprint': thread_fingerprint(thread),
                    'action_type': action_type,
                    'body': body,
                })

            proposal_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc).isoformat()
            conn = get_db()
            conn.execute(
                'INSERT INTO revision_proposals '
                '(id, project_id, author_id, title, summary, base_commit_sha, status, created_at) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (proposal_id, project_id, uid, title, summary, base_commit, 'pending', now)
            )
            conn.executemany(
                'INSERT INTO revision_proposal_files '
                '(proposal_id, file_path, base_content, proposed_content) VALUES (?, ?, ?, ?)',
                [(proposal_id, path, base, proposed) for path, base, proposed in normalized_files]
            )
            conn.executemany(
                'INSERT INTO revision_proposal_comment_actions '
                '(id, proposal_id, thread_id, file_path, source_commit_sha, source_fingerprint, action_type, body) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    (
                        action['id'], proposal_id, action['thread_id'], action['file_path'],
                        action['source_commit_sha'], action['source_fingerprint'],
                        action['action_type'], action['body']
                    )
                    for action in normalized_actions
                ]
            )
            conn.commit()
            return jsonify(proposal_detail(proposal_row(proposal_id))), 201
    finally:
        if release_after:
            release_project_lock(project_id, uid)


@proposal_bp.route('/projects/<project_id>/proposals/<proposal_id>', methods=['GET'])
@require_auth
def get_proposal(project_id, proposal_id):
    project, error = get_project_or_error(project_id, session['user_id'])
    if error:
        return error
    row = proposal_row(proposal_id, project_id)
    if not row:
        return jsonify({'error': 'Not found'}), 404
    row = refresh_stale_status(row, resolve_project_root(project['project_path']))
    return jsonify(proposal_detail(row))


@proposal_bp.route('/projects/<project_id>/proposals/<proposal_id>', methods=['DELETE'])
@require_auth
@with_proposal_project_lock
def delete_proposal(project_id, proposal_id):
    uid = session['user_id']
    project, error = get_project_or_error(project_id, uid)
    if error:
        return error
    row = proposal_row(proposal_id, project_id)
    if not row:
        return jsonify({'error': 'Not found'}), 404
    if row['author_id'] != uid and project['owner_id'] != uid:
        return jsonify({'error': 'Only the proposal author or project owner can delete it'}), 403
    if row['status'] == 'accepted':
        return jsonify({
            'error': 'Published proposals are retained as audit history',
            'code': 'accepted',
        }), 409

    conn = get_db()
    conn.execute('DELETE FROM revision_proposals WHERE id = ? AND project_id = ?', (proposal_id, project_id))
    conn.commit()
    return jsonify({'deleted': True, 'id': proposal_id})


@proposal_bp.route('/projects/<project_id>/proposals/<proposal_id>/decisions', methods=['PUT'])
@require_auth
@with_proposal_project_lock
def save_proposal_decisions(project_id, proposal_id):
    uid = session['user_id']
    project, error = require_editor(project_id, uid)
    if error:
        return error
    row = proposal_row(proposal_id, project_id)
    if not row:
        return jsonify({'error': 'Not found'}), 404
    row = refresh_stale_status(row, resolve_project_root(project['project_path']))
    if row['status'] != 'pending':
        return jsonify({'error': f"Proposal is {row['status']}", 'code': row['status']}), 409
    if row['author_id'] == uid:
        return jsonify({'error': 'Proposal authors cannot review their own proposal'}), 403
    data = request.get_json() or {}
    items = data.get('items')
    if not isinstance(items, list) or not items:
        return jsonify({'error': 'items required'}), 400
    valid = required_items(proposal_id)
    now = datetime.now(timezone.utc).isoformat()
    normalized = []
    for item in items:
        kind = (item.get('kind') or '').strip()
        file_path = (item.get('filePath') or '').strip() if kind == 'diff' else ''
        item_id = (item.get('itemId') or '').strip()
        decision = (item.get('decision') or '').strip()
        key = (kind, file_path, item_id)
        if key not in valid:
            return jsonify({'error': f'Unknown proposal review item: {item_id}'}), 400
        if decision not in DECISIONS:
            return jsonify({'error': 'decision must be accept or refuse'}), 400
        normalized.append((proposal_id, kind, file_path, item_id, decision, uid, now))
    conn = get_db()
    conn.executemany(
        'INSERT INTO revision_proposal_decisions '
        '(proposal_id, item_kind, file_path, item_id, decision, reviewer_id, updated_at) '
        'VALUES (?, ?, ?, ?, ?, ?, ?) '
        'ON CONFLICT(proposal_id, item_kind, file_path, item_id) DO UPDATE SET '
        'decision = excluded.decision, reviewer_id = excluded.reviewer_id, updated_at = excluded.updated_at',
        normalized
    )
    conn.commit()
    return jsonify(proposal_detail(proposal_row(proposal_id)))


def prepare_comment_actions(project_root, actions, proposal_author_id, proposal_author_username):
    stores = {}
    snapshots = {}
    now = datetime.now(timezone.utc).isoformat()
    for action in actions:
        store, thread = find_thread(
            project_root, action['file_path'], action['source_commit_sha'], action['thread_id']
        )
        if not store or not thread or thread_fingerprint(thread) != action['source_fingerprint']:
            raise RuntimeError('A referenced comment thread changed during publication.')
        key = (action['file_path'], store['commitSha'])
        if key not in stores:
            stores[key] = store
            snapshots[key] = copy.deepcopy(store)
        target = next(item for item in stores[key]['threads'] if item.get('id') == action['thread_id'])
        if action['action_type'] == 'reply':
            target.setdefault('comments', []).append({
                'id': str(uuid.uuid4()),
                'threadId': action['thread_id'],
                'userId': proposal_author_id,
                'body': action['body'],
                'createdAt': now,
                'username': proposal_author_username,
            })
        else:
            target['resolved'] = True
            target['resolvedBy'] = proposal_author_id
            target['resolvedAt'] = now
    return stores, snapshots


def save_comment_stores(project_root, stores):
    for (file_path, commit_sha), store in stores.items():
        save_comment_store(project_root, file_path, commit_sha, store)


def restore_comment_stores(project_root, snapshots):
    for (file_path, commit_sha), store in snapshots.items():
        save_comment_store(project_root, file_path, commit_sha, store)


@proposal_bp.route('/projects/<project_id>/proposals/<proposal_id>/publish', methods=['POST'])
@require_auth
def publish_proposal(project_id, proposal_id):
    uid = session['user_id']
    project, error = require_editor(project_id, uid)
    if error:
        return error
    row = proposal_row(proposal_id, project_id)
    if not row:
        return jsonify({'error': 'Not found'}), 404
    if row['author_id'] == uid:
        return jsonify({'error': 'Proposal authors cannot publish their own proposal'}), 403
    if row['status'] != 'pending':
        return jsonify({'error': f"Proposal is {row['status']}", 'code': row['status']}), 409

    release_after, lock_error = acquire_temporary_lease(project_id, uid)
    if lock_error:
        return lock_conflict(project_id, uid)

    project_root = resolve_project_root(project['project_path'])
    comment_snapshots = {}
    external_started = False
    try:
        with project_write_lock(project_root):
            row = proposal_row(proposal_id, project_id)
            if row['status'] != 'pending':
                return jsonify({'error': f"Proposal is {row['status']}", 'code': row['status']}), 409
            reason = stale_reason(row, project_root)
            if reason:
                conn = get_db()
                conn.execute(
                    "UPDATE revision_proposals SET status = 'stale', stale_reason = ? WHERE id = ?",
                    (reason, proposal_id)
                )
                conn.commit()
                return jsonify({'error': reason, 'code': 'stale'}), 409

            required = required_items(proposal_id)
            decisions = {
                (item['item_kind'], item['file_path'], item['item_id']): item['decision']
                for item in load_decisions(proposal_id)
            }
            if not required or any(key not in decisions for key in required):
                return jsonify({'error': 'Every proposal item must be accepted or refused'}), 409
            if not any(decisions[key] == 'accept' for key in required):
                return jsonify({'error': 'At least one proposal item must be accepted'}), 409

            final_files = []
            for item in load_proposal_files(proposal_id):
                decision_payload = []
                diff = compute_diff(item['base_content'], item['proposed_content'])
                for chunk in actionable_chunks(diff):
                    decision_payload.append({
                        'rowId': chunk['rowId'],
                        'chunkId': chunk['chunkId'],
                        'decision': decisions[('diff', item['file_path'], chunk['itemId'])],
                    })
                applied = apply_diff_decisions(
                    item['base_content'], item['proposed_content'], item['base_content'], decision_payload
                )
                if applied['content'] != item['base_content']:
                    final_files.append((item['file_path'], applied['content']))

            accepted_actions = [
                action for action in load_comment_actions(proposal_id)
                if decisions[('comment', '', action['id'])] == 'accept'
            ]

            for file_path, content in final_files:
                external_started = True
                write_project_file(project_root, file_path, content)

            head = row['base_commit_sha']
            if final_files:
                head = git_commit_paths(
                    project_root,
                    [path for path, _ in final_files],
                    f"Accept proposal: {row['title']}"
                )

            if accepted_actions:
                comment_stores, comment_snapshots = prepare_comment_actions(
                    project_root, accepted_actions, row['author_id'], row['author_username']
                )
                external_started = True
                save_comment_stores(project_root, comment_stores)

            now = datetime.now(timezone.utc).isoformat()
            conn = get_db()
            try:
                for file_path, content in final_files:
                    next_version = conn.execute(
                        'SELECT COALESCE(MAX(version), 0) + 1 FROM file_versions '
                        'WHERE project_id = ? AND file_path = ?',
                        (project_id, file_path)
                    ).fetchone()[0]
                    conn.execute(
                        'INSERT INTO file_versions '
                        '(id, project_id, file_path, version, content, message, author_id, created_at) '
                        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        (
                            str(uuid.uuid4()), project_id, file_path, next_version, content,
                            f"Accepted proposal: {row['title']}", row['author_id'], now
                        )
                    )
                if final_files:
                    conn.execute(
                        'UPDATE projects SET updated_by = ?, updated_at = ? WHERE id = ?',
                        (row['author_id'], now, project_id)
                    )
                conn.execute(
                    "UPDATE revision_proposals SET status = 'accepted', stale_reason = NULL, "
                    'decided_by = ?, decided_at = ?, applied_commit_sha = ? WHERE id = ?',
                    (uid, now, head, proposal_id)
                )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            return jsonify(proposal_detail(proposal_row(proposal_id)))
    except Exception as exc:
        if external_started:
            try:
                reset_project_to_commit(project_root, row['base_commit_sha'])
                restore_comment_stores(project_root, comment_snapshots)
            except Exception:
                pass
        return jsonify({'error': f'Proposal publication failed: {exc}'}), 500
    finally:
        if release_after:
            release_project_lock(project_id, uid)


@proposal_bp.route('/projects/<project_id>/proposals/<proposal_id>/reject', methods=['POST'])
@require_auth
@with_proposal_project_lock
def reject_proposal(project_id, proposal_id):
    uid = session['user_id']
    _, error = require_editor(project_id, uid)
    if error:
        return error
    row = proposal_row(proposal_id, project_id)
    if not row:
        return jsonify({'error': 'Not found'}), 404
    if row['author_id'] == uid:
        return jsonify({'error': 'Proposal authors cannot reject their own proposal'}), 403
    if row['status'] != 'pending':
        return jsonify({'error': f"Proposal is {row['status']}", 'code': row['status']}), 409
    now = datetime.now(timezone.utc).isoformat()
    conn = get_db()
    conn.execute(
        "UPDATE revision_proposals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?",
        (uid, now, proposal_id)
    )
    conn.commit()
    return jsonify(proposal_detail(proposal_row(proposal_id)))
