import json
import uuid
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, session
from models import get_db, get_document_for_user, user_owns_thread, user_can_edit_document
from utils.diff import compute_diff

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

    diff_json = compute_diff(va['markdown'], vb['markdown'])
    return jsonify({
        'diff': json.loads(diff_json),
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

    diff_json = compute_diff(ver['markdown'], ver['markdown'])
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

# ===== Comments / Threads (unchanged) =====

@review_bp.route('/comments/threads', methods=['POST'])
@require_auth
def create_thread():
    uid = session['user_id']
    data = request.get_json()
    if not data or not data.get('documentId'):
        return jsonify({'error': 'documentId required'}), 400

    thread_id = str(uuid.uuid4())
    doc_id = data['documentId']
    cs_id = data.get('changeSetId')
    now = datetime.now(timezone.utc).isoformat()

    ownership_error = require_document_access(doc_id, uid)
    if ownership_error:
        return ownership_error

    conn = get_db()
    conn.execute(
        "INSERT INTO comment_threads (id, document_id, change_set_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
        (thread_id, doc_id, cs_id, uid, now)
    )
    conn.commit()

    if data.get('body'):
        comment_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO comments (id, thread_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
            (comment_id, thread_id, uid, data['body'], now)
        )
        conn.commit()

    if data.get('anchor'):
        anchor = data['anchor']
        anchor_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO comment_anchors (id, thread_id, start_line, end_line, selected_text) VALUES (?, ?, ?, ?, ?)",
            (anchor_id, thread_id, anchor.get('startLine', 1), anchor.get('endLine', 1), anchor.get('selectedText'))
        )
        conn.commit()

    return jsonify({'id': thread_id, 'documentId': doc_id, 'changeSetId': cs_id, 'createdBy': uid, 'createdAt': now}), 201

@review_bp.route('/comment-lines', methods=['POST'])
@require_auth
def add_comment():
    uid = session['user_id']
    data = request.get_json()
    if not data or 'threadId' not in data or 'body' not in data:
        return jsonify({'error': 'threadId and body required'}), 400

    if not user_owns_thread(data['threadId'], uid):
        return jsonify({'error': 'Not found'}), 404
    thread_row = get_db().execute(
        "SELECT document_id FROM comment_threads WHERE id = ?",
        (data['threadId'],)
    ).fetchone()
    if not thread_row:
        return jsonify({'error': 'Not found'}), 404
    access_error = require_document_access(thread_row['document_id'], uid)
    if access_error:
        return access_error

    comment_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    conn = get_db()
    conn.execute(
        "INSERT INTO comments (id, thread_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
        (comment_id, data['threadId'], uid, data['body'], now)
    )
    conn.commit()
    return jsonify({'id': comment_id, 'threadId': data['threadId'], 'userId': uid, 'body': data['body'], 'createdAt': now}), 201

@review_bp.route('/documents/<doc_id>/threads', methods=['GET'])
@require_auth
def list_threads(doc_id):
    ownership_error = require_document_access(doc_id, session['user_id'])
    if ownership_error:
        return ownership_error
    conn = get_db()
    rows = conn.execute(
        "SELECT ct.* FROM comment_threads ct WHERE ct.document_id = ? AND ct.change_set_id IS NULL ORDER BY ct.created_at DESC",
        (doc_id,)
    ).fetchall()
    all_threads = []
    for r in rows:
        raw = dict(r)
        thread = {
            'id': raw['id'],
            'documentId': raw['document_id'],
            'changeSetId': raw['change_set_id'],
            'createdBy': raw['created_by'],
            'createdAt': raw['created_at'],
            'resolved': raw.get('resolved', 0),
            'resolvedBy': raw.get('resolved_by'),
            'resolvedAt': raw.get('resolved_at'),
        }
        comments = conn.execute(
            "SELECT c.*, u.username FROM comments c JOIN users u ON c.user_id = u.id WHERE c.thread_id = ? ORDER BY c.created_at ASC",
            (thread['id'],)
        ).fetchall()
        thread['comments'] = [
            {
                'id': dict(c)['id'],
                'threadId': dict(c)['thread_id'],
                'userId': dict(c)['user_id'],
                'body': dict(c)['body'],
                'createdAt': dict(c)['created_at'],
                'username': dict(c)['username'],
            }
            for c in comments
        ]
        anchor_row = conn.execute("SELECT * FROM comment_anchors WHERE thread_id = ?", (thread['id'],)).fetchone()
        if anchor_row:
            a = dict(anchor_row)
            thread['anchor'] = {
                'startLine': a['start_line'],
                'endLine': a['end_line'],
                'selectedText': a.get('selected_text'),
            }
        else:
            thread['anchor'] = None
        u = conn.execute("SELECT username FROM users WHERE id = ?", (thread['createdBy'],)).fetchone()
        thread['createdByUsername'] = u['username'] if u else ''
        all_threads.append(thread)
    return jsonify(all_threads)

@review_bp.route('/comments/threads/<thread_id>/resolve', methods=['POST'])
@require_auth
def toggle_resolve(thread_id):
    uid = session['user_id']
    if not user_owns_thread(thread_id, uid):
        return jsonify({'error': 'Not found'}), 404
    conn = get_db()
    row = conn.execute("SELECT id, document_id FROM comment_threads WHERE id = ?", (thread_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    edit_error = require_document_edit(row['document_id'], uid)
    if edit_error:
        return edit_error

    now = datetime.now(timezone.utc).isoformat()
    try:
        current = conn.execute("SELECT resolved FROM comment_threads WHERE id = ?", (thread_id,)).fetchone()
        new_resolved = 0 if (current and current['resolved']) else 1
    except:
        new_resolved = 1

    resolved_by = uid if new_resolved else None
    resolved_at = now if new_resolved else None

    conn.execute(
        "UPDATE comment_threads SET resolved = ?, resolved_by = ?, resolved_at = ? WHERE id = ?",
        (new_resolved, resolved_by, resolved_at, thread_id)
    )
    conn.commit()
    return jsonify({'id': thread_id, 'resolved': bool(new_resolved), 'resolvedBy': resolved_by, 'resolvedAt': resolved_at})
