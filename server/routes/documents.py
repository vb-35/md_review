import uuid
import json
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, session
from models import get_db, get_document_for_user
from utils.renderer import markdown_to_html
from utils.diff import compute_diff

doc_bp = Blueprint('documents', __name__)
SHARE_ROLES = {'viewer', 'editor'}

def require_auth(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Not authenticated'}), 401
        return f(*args, **kwargs)
    return decorated

def document_to_api(doc):
    return {
        'id': doc['id'],
        'title': doc['title'],
        'markdown': doc.get('markdown'),
        'ownerId': doc['owner_id'],
        'ownerUsername': doc.get('owner_username'),
        'updatedBy': doc['updated_by'],
        'updatedByUsername': doc.get('updated_by_username'),
        'updatedAt': doc['updated_at'],
        'lockOwnerId': doc.get('lock_owner_id'),
        'lockOwnerUsername': doc.get('lock_owner_username'),
        'lockedAt': doc.get('locked_at'),
        'accessRole': doc.get('access_role'),
        'isOwner': bool(doc.get('is_owner')),
        'sharedByUsername': doc.get('shared_by_username'),
    }

def get_accessible_document_or_404(doc_id, user_id):
    row = get_document_for_user(doc_id, user_id)
    if not row:
        return None, (jsonify({'error': 'Not found'}), 404)
    return row, None

def require_edit_access(doc):
    if doc['access_role'] not in ('owner', 'editor'):
        return jsonify({'error': 'Forbidden'}), 403
    return None

def require_owner_access(doc):
    if not doc['is_owner']:
        return jsonify({'error': 'Forbidden'}), 403
    return None

@doc_bp.route('/documents', methods=['GET'])
@require_auth
def list_documents():
    conn = get_db()
    uid = session['user_id']
    rows = conn.execute(
        "SELECT d.*, "
        "owner.username AS owner_username, "
        "updater.username AS updated_by_username, "
        "locker.username AS lock_owner_username, "
        "'owner' AS access_role, "
        "1 AS is_owner, "
        "NULL AS shared_by_username "
        "FROM documents d "
        "JOIN users owner ON owner.id = d.owner_id "
        "LEFT JOIN users updater ON updater.id = d.updated_by "
        "LEFT JOIN users locker ON locker.id = d.lock_owner_id "
        "WHERE d.owner_id = ? "
        "UNION ALL "
        "SELECT d.*, "
        "owner.username AS owner_username, "
        "updater.username AS updated_by_username, "
        "locker.username AS lock_owner_username, "
        "ds.role AS access_role, "
        "0 AS is_owner, "
        "sharer.username AS shared_by_username "
        "FROM documents d "
        "JOIN document_shares ds ON ds.document_id = d.id "
        "JOIN users owner ON owner.id = d.owner_id "
        "LEFT JOIN users updater ON updater.id = d.updated_by "
        "LEFT JOIN users locker ON locker.id = d.lock_owner_id "
        "LEFT JOIN users sharer ON sharer.id = ds.shared_by "
        "WHERE ds.user_id = ? "
        "ORDER BY updated_at DESC",
        (uid, uid)
    ).fetchall()
    return jsonify([document_to_api(dict(r)) for r in rows])

@doc_bp.route('/documents', methods=['POST'])
@require_auth
def create_document():
    data = request.get_json()
    if not data or not data.get('title'):
        return jsonify({'error': 'title required'}), 400

    doc_id = str(uuid.uuid4())
    uid = session['user_id']
    now = datetime.now(timezone.utc).isoformat()
    md = data.get('markdown', '')
    html_cache = markdown_to_html(md)

    conn = get_db()
    username_row = conn.execute("SELECT username FROM users WHERE id = ?", (uid,)).fetchone()
    username_val = username_row['username'] if username_row else uid

    conn.execute(
        "INSERT INTO documents (id, title, markdown, html_cache, owner_id, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (doc_id, data['title'], md, html_cache, uid, uid, now)
    )

    version_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO document_versions (id, document_id, version, markdown, diff, message, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (version_id, doc_id, 1, md, '[]', f'Created by {username_val}', uid, now)
    )
    conn.commit()

    row = get_document_for_user(doc_id, uid)
    return jsonify(document_to_api(row)), 201

@doc_bp.route('/documents/<doc_id>', methods=['GET'])
@require_auth
def get_document(doc_id):
    row, error = get_accessible_document_or_404(doc_id, session['user_id'])
    if error:
        return error
    return jsonify(document_to_api(row))

@doc_bp.route('/documents/<doc_id>', methods=['PUT'])
@require_auth
def update_document(doc_id):
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body required'}), 400

    uid = session['user_id']
    conn = get_db()
    row, error = get_accessible_document_or_404(doc_id, uid)
    if error:
        return error
    permission_error = require_edit_access(row)
    if permission_error:
        return permission_error

    md = data.get('markdown', row['markdown'])
    title = data.get('title', row['title'])
    html_cache = markdown_to_html(md)
    now = datetime.now(timezone.utc).isoformat()

    old_md = row['markdown']
    diff_json = compute_diff(old_md, md)
    version = conn.execute(
        "SELECT COALESCE(MAX(version), 0) + 1 FROM document_versions WHERE document_id = ?",
        (doc_id,)
    ).fetchone()[0]

    conn.execute(
        "UPDATE documents SET title = ?, markdown = ?, html_cache = ?, updated_by = ?, updated_at = ? WHERE id = ?",
        (title, md, html_cache, uid, now, doc_id)
    )

    version_id = str(uuid.uuid4())
    author = conn.execute("SELECT username FROM users WHERE id = ?", (uid,)).fetchone()
    author_name = author['username'] if author else uid
    conn.execute(
        "INSERT INTO document_versions (id, document_id, version, markdown, diff, message, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (version_id, doc_id, version, md, json.dumps(diff_json), f"Saved by {author_name}", uid, now)
    )
    conn.commit()
    return jsonify(document_to_api(get_document_for_user(doc_id, uid)))

@doc_bp.route('/documents/<doc_id>', methods=['DELETE'])
@require_auth
def delete_document(doc_id):
    uid = session['user_id']
    conn = get_db()
    row, error = get_accessible_document_or_404(doc_id, uid)
    if error:
        return error
    permission_error = require_owner_access(row)
    if permission_error:
        return permission_error
    conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    conn.commit()
    return jsonify({'ok': True})

@doc_bp.route('/documents/<doc_id>/lock', methods=['POST'])
@require_auth
def lock_document(doc_id):
    uid = session['user_id']
    conn = get_db()
    row, error = get_accessible_document_or_404(doc_id, uid)
    if error:
        return error
    permission_error = require_edit_access(row)
    if permission_error:
        return permission_error
    if row['lock_owner_id'] and row['lock_owner_id'] != uid:
        return jsonify({'error': 'Document is locked by another user'}), 423
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("UPDATE documents SET lock_owner_id = ?, locked_at = ? WHERE id = ?", (uid, now, doc_id))
    conn.commit()
    return jsonify(document_to_api(get_document_for_user(doc_id, uid)))

@doc_bp.route('/documents/<doc_id>/lock', methods=['DELETE'])
@require_auth
def unlock_document(doc_id):
    uid = session['user_id']
    conn = get_db()
    row, error = get_accessible_document_or_404(doc_id, uid)
    if error:
        return error
    permission_error = require_edit_access(row)
    if permission_error:
        return permission_error
    if row['lock_owner_id'] and row['lock_owner_id'] != uid:
        return jsonify({'error': 'You do not own this lock'}), 403
    conn.execute("UPDATE documents SET lock_owner_id = NULL, locked_at = NULL WHERE id = ?", (doc_id,))
    conn.commit()
    return jsonify({'ok': True})

@doc_bp.route('/documents/<doc_id>/shares', methods=['GET'])
@require_auth
def list_document_shares(doc_id):
    row, error = get_accessible_document_or_404(doc_id, session['user_id'])
    if error:
        return error
    permission_error = require_owner_access(row)
    if permission_error:
        return permission_error

    shares = get_db().execute(
        "SELECT ds.document_id, ds.user_id, u.username, ds.role, ds.shared_by, "
        "sharer.username AS shared_by_username, ds.created_at "
        "FROM document_shares ds "
        "JOIN users u ON u.id = ds.user_id "
        "JOIN users sharer ON sharer.id = ds.shared_by "
        "WHERE ds.document_id = ? "
        "ORDER BY u.username ASC",
        (doc_id,)
    ).fetchall()
    return jsonify([
        {
            'documentId': s['document_id'],
            'userId': s['user_id'],
            'username': s['username'],
            'role': s['role'],
            'sharedBy': s['shared_by'],
            'sharedByUsername': s['shared_by_username'],
            'createdAt': s['created_at'],
        }
        for s in shares
    ])

@doc_bp.route('/documents/<doc_id>/shares', methods=['POST'])
@require_auth
def create_or_update_share(doc_id):
    uid = session['user_id']
    row, error = get_accessible_document_or_404(doc_id, uid)
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
    user_row = conn.execute(
        "SELECT id, username FROM users WHERE username = ?",
        (username,)
    ).fetchone()
    if not user_row:
        return jsonify({'error': 'User not found'}), 404
    if user_row['id'] == row['owner_id']:
        return jsonify({'error': 'Owner already has access'}), 400

    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO document_shares (document_id, user_id, role, shared_by, created_at) "
        "VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(document_id, user_id) DO UPDATE SET "
        "role = excluded.role, shared_by = excluded.shared_by, created_at = excluded.created_at",
        (doc_id, user_row['id'], role, uid, now)
    )
    conn.commit()

    share = conn.execute(
        "SELECT ds.document_id, ds.user_id, u.username, ds.role, ds.shared_by, "
        "sharer.username AS shared_by_username, ds.created_at "
        "FROM document_shares ds "
        "JOIN users u ON u.id = ds.user_id "
        "JOIN users sharer ON sharer.id = ds.shared_by "
        "WHERE ds.document_id = ? AND ds.user_id = ?",
        (doc_id, user_row['id'])
    ).fetchone()
    return jsonify({
        'documentId': share['document_id'],
        'userId': share['user_id'],
        'username': share['username'],
        'role': share['role'],
        'sharedBy': share['shared_by'],
        'sharedByUsername': share['shared_by_username'],
        'createdAt': share['created_at'],
    })

@doc_bp.route('/documents/<doc_id>/shares/<user_id>', methods=['DELETE'])
@require_auth
def delete_share(doc_id, user_id):
    uid = session['user_id']
    row, error = get_accessible_document_or_404(doc_id, uid)
    if error:
        return error
    permission_error = require_owner_access(row)
    if permission_error:
        return permission_error

    conn = get_db()
    deleted = conn.execute(
        "DELETE FROM document_shares WHERE document_id = ? AND user_id = ?",
        (doc_id, user_id)
    )
    conn.commit()
    if deleted.rowcount == 0:
        return jsonify({'error': 'Share not found'}), 404
    return jsonify({'ok': True})
