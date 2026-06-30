import uuid
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, session
from models import get_db, get_document_for_user, user_can_edit_document
from utils.diff import compute_diff
from utils.repo_storage import (
    load_applicable_comment_stores,
    load_comment_store,
    list_applicable_comment_store_commits,
    normalize_repo_relative_path,
    save_comment_store,
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

def require_document_access(doc_id, user_id):
    if not get_document_for_user(doc_id, user_id):
        return jsonify({'error': 'Not found'}), 404
    return None

def require_document_edit(doc_id, user_id):
    access_error = require_document_access(doc_id, user_id)
    if access_error:
        return access_error
    if not user_can_edit_document(doc_id, user_id):
        return jsonify({'error': 'Forbidden'}), 403
    return None

# ===== Version History =====

@review_bp.route('/documents/<doc_id>/versions', methods=['GET'])
@require_auth
def list_versions(doc_id):
    ownership_error = require_document_access(doc_id, session['user_id'])
    if ownership_error:
        return ownership_error
    conn = get_db()
    rows = conn.execute(
        "SELECT dv.*, u.username AS author_name "
        "FROM document_versions dv "
        "JOIN users u ON dv.author_id = u.id "
        "WHERE dv.document_id = ? "
        "ORDER BY dv.version DESC",
        (doc_id,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])

@review_bp.route('/versions', methods=['POST'])
@require_auth
def compare_versions():
    """Diff two versions. POST body: { documentId, versionA, versionB }"""
    data = request.get_json()
    if not data or not data.get('documentId'):
        return jsonify({'error': 'documentId required'}), 400

    doc_id = data['documentId']
    ver_a = data.get('versionA')
    ver_b = data.get('versionB')

    if not ver_a or not ver_b:
        return jsonify({'error': 'versionA and versionB required'}), 400

    ownership_error = require_document_access(doc_id, session['user_id'])
    if ownership_error:
        return ownership_error

    conn = get_db()
    va = conn.execute("SELECT * FROM document_versions WHERE id = ? AND document_id = ?", (ver_a, doc_id)).fetchone()
    vb = conn.execute("SELECT * FROM document_versions WHERE id = ? AND document_id = ?", (ver_b, doc_id)).fetchone()

    if not va or not vb:
        return jsonify({'error': 'Version not found'}), 404

    diff_rows = compute_diff(va['markdown'], vb['markdown'])
    return jsonify({
        'diff': diff_rows,
        'versionA': va['version'],
        'versionB': vb['version'],
        'authorA': va['author_id'],
        'authorB': vb['author_id'],
        'createdAtA': va['created_at'],
        'createdAtB': vb['created_at'],
    })

@review_bp.route('/versions/<version_id>/revert', methods=['POST'])
@require_auth
def revert_version(version_id):
    uid = session['user_id']
    conn = get_db()
    ver = conn.execute("SELECT * FROM document_versions WHERE id = ?", (version_id,)).fetchone()
    if not ver:
        return jsonify({'error': 'Version not found'}), 404

    doc_id = ver['document_id']
    ownership_error = require_document_edit(doc_id, uid)
    if ownership_error:
        return ownership_error
    now = datetime.now(timezone.utc).isoformat()
    md = ver['markdown']

    from utils.renderer import markdown_to_html
    html_cache = markdown_to_html(md)

    # Update document content
    conn.execute(
        "UPDATE documents SET markdown = ?, html_cache = ?, updated_by = ?, updated_at = ? WHERE id = ?",
        (md, html_cache, uid, now, doc_id)
    )

    # Create new version for the revert
    next_version = conn.execute(
        "SELECT COALESCE(MAX(version), 0) + 1 FROM document_versions WHERE document_id = ?", (doc_id,)
    ).fetchone()[0]

    author = conn.execute("SELECT username FROM users WHERE id = ?", (uid,)).fetchone()
    author_name = author['username'] if author else uid
    reverted_from = ver['version']

    new_version_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO document_versions (id, document_id, version, markdown, diff, message, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (new_version_id, doc_id, next_version, md, '[]', f"Reverted to v{reverted_from} by {author_name}", uid, now)
    )

    conn.commit()
    return jsonify({'id': new_version_id, 'version': next_version, 'revertedFrom': reverted_from})

# ===== Comments / Threads =====

def normalize_comment_context(data):
    if not data or not data.get('documentId'):
        return None, (jsonify({'error': 'documentId required'}), 400)
    if not data.get('commitSha'):
        return None, (jsonify({'error': 'commitSha required'}), 400)
    if not data.get('filePath'):
        return None, (jsonify({'error': 'filePath required'}), 400)
    try:
        file_path = normalize_repo_relative_path(data['filePath'])
    except ValueError as exc:
        return None, (jsonify({'error': str(exc)}), 400)
    return {
        'documentId': data['documentId'],
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
    access_error = require_document_access(context['documentId'], uid)
    if access_error:
        return None, None, access_error
    for store in load_applicable_comment_stores(context['filePath'], context['commitSha']):
        thread = next((t for t in store.get('threads', []) if t.get('id') == thread_id), None)
        if thread:
            context['commitSha'] = store.get('commitSha', context['commitSha'])
            return context, store, None
    return None, None, (jsonify({'error': 'Not found'}), 404)

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

    ownership_error = require_document_access(context['documentId'], uid)
    if ownership_error:
        return ownership_error

    store = load_comment_store(context['filePath'], context['commitSha'])
    thread = {
        'id': thread_id,
        'documentId': context['documentId'],
        'filePath': context['filePath'],
        'commitSha': context['commitSha'],
        'changeSetId': data.get('changeSetId'),
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
    save_comment_store(context['filePath'], context['commitSha'], store)
    return jsonify({
        'id': thread_id,
        'documentId': context['documentId'],
        'filePath': context['filePath'],
        'commitSha': context['commitSha'],
        'createdBy': uid,
        'createdAt': now
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
    thread = next(t for t in store['threads'] if t['id'] == data['threadId'])
    thread.setdefault('comments', []).append({
        'id': comment_id,
        'threadId': data['threadId'],
        'userId': uid,
        'body': data['body'],
        'createdAt': now,
        'username': session.get('username', ''),
    })
    save_comment_store(context['filePath'], context['commitSha'], store)
    return jsonify({'id': comment_id, 'threadId': data['threadId'], 'userId': uid, 'body': data['body'], 'createdAt': now}), 201

@review_bp.route('/documents/<doc_id>/threads', methods=['GET'])
@require_auth
def list_threads(doc_id):
    ownership_error = require_document_access(doc_id, session['user_id'])
    if ownership_error:
        return ownership_error
    commit_sha = request.args.get('commitSha')
    file_path = request.args.get('filePath')
    if not commit_sha or not file_path:
        return jsonify([])
    try:
        stores = load_applicable_comment_stores(file_path, commit_sha)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    merged_threads = []
    for store in stores:
        merged_threads.extend(store.get('threads', []))
    threads = [
        serialize_thread(thread)
        for thread in sorted(merged_threads, key=lambda item: item.get('createdAt', ''), reverse=True)
        if thread.get('documentId') == doc_id and not thread.get('changeSetId')
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
    edit_error = require_document_edit(context['documentId'], uid)
    if edit_error:
        return edit_error

    now = datetime.now(timezone.utc).isoformat()
    thread = next(t for t in store['threads'] if t['id'] == thread_id)
    new_resolved = not bool(thread.get('resolved'))
    thread['resolved'] = new_resolved
    thread['resolvedBy'] = uid if new_resolved else None
    thread['resolvedAt'] = now if new_resolved else None
    save_comment_store(context['filePath'], context['commitSha'], store)
    return jsonify({
        'id': thread_id,
        'resolved': bool(new_resolved),
        'resolvedBy': thread['resolvedBy'],
        'resolvedAt': thread['resolvedAt']
    })


@review_bp.route('/comments/threads/<thread_id>', methods=['DELETE'])
@require_auth
def delete_thread(thread_id):
    uid = session['user_id']
    data = request.get_json() or {}
    context, store, error = require_thread_edit_context(thread_id, uid, data)
    if error:
        return error
    edit_error = require_document_edit(context['documentId'], uid)
    if edit_error:
        return edit_error

    thread = next(t for t in store['threads'] if t['id'] == thread_id)
    if not thread.get('resolved'):
        return jsonify({'error': 'Resolved thread required'}), 400

    changed = False
    for item_commit in list_applicable_comment_store_commits(context['filePath'], context['commitSha']):
        item_store = load_comment_store(context['filePath'], item_commit)
        original_count = len(item_store.get('threads', []))
        item_store['threads'] = [item for item in item_store.get('threads', []) if item.get('id') != thread_id]
        if len(item_store['threads']) != original_count:
            save_comment_store(context['filePath'], item_commit, item_store)
            changed = True

    return jsonify({'id': thread_id, 'deleted': changed})
