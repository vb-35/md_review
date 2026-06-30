import uuid
import json
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, session
from models import get_db, ensure_user, row_to_dict
from utils.renderer import markdown_to_html
from utils.diff import compute_diff

doc_bp = Blueprint('documents', __name__)

def require_auth(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Not authenticated'}), 401
        return f(*args, **kwargs)
    return decorated

@doc_bp.route('/documents', methods=['GET'])
@require_auth
def list_documents():
    conn = get_db()
    rows = conn.execute("SELECT id, title, updated_by, updated_at, lock_owner_id FROM documents ORDER BY updated_at DESC").fetchall()
    return jsonify([dict(r) for r in rows])

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
        "INSERT INTO documents (id, title, markdown, html_cache, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (doc_id, data['title'], md, html_cache, uid, now)
    )

    # Create initial version
    version_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO document_versions (id, document_id, version, markdown, diff, message, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (version_id, doc_id, 1, md, '[]', f'Created by {username_val}', uid, now)
    )
    conn.commit()
    return jsonify({'id': doc_id, 'title': data['title'], 'markdown': md, 'updatedBy': uid, 'updatedAt': now, 'version': 1}), 201

@doc_bp.route('/documents/<doc_id>', methods=['GET'])
@require_auth
def get_document(doc_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(row_to_dict(row))

@doc_bp.route('/documents/<doc_id>', methods=['PUT'])
@require_auth
def update_document(doc_id):
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Request body required'}), 400

    uid = session['user_id']
    conn = get_db()
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404

    md = data.get('markdown', row['markdown'])
    title = data.get('title', row['title'])
    html_cache = markdown_to_html(md)
    now = datetime.now(timezone.utc).isoformat()

    old_md = row['markdown']
    diff_json = compute_diff(old_md, md)
    version = (conn.execute("SELECT COALESCE(MAX(version), 0) + 1 FROM document_versions WHERE document_id = ?", (doc_id,)).fetchone()[0])

    conn.execute(
        "UPDATE documents SET title = ?, markdown = ?, html_cache = ?, updated_by = ?, updated_at = ? WHERE id = ?",
        (title, md, html_cache, uid, now, doc_id)
    )

    # Create a version record
    version_id = str(uuid.uuid4())
    author = conn.execute("SELECT username FROM users WHERE id = ?", (uid,)).fetchone()
    author_name = author['username'] if author else uid
    conn.execute(
        "INSERT INTO document_versions (id, document_id, version, markdown, diff, message, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (version_id, doc_id, version, md, json.dumps(diff_json), f"Saved by {author_name}", uid, now)
    )
    conn.commit()
    return jsonify({'id': doc_id, 'title': title, 'markdown': md, 'updatedBy': uid, 'updatedAt': now, 'version': version})

@doc_bp.route('/documents/<doc_id>', methods=['DELETE'])
@require_auth
def delete_document(doc_id):
    conn = get_db()
    row = conn.execute("SELECT id FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    conn.commit()
    return jsonify({'ok': True})

@doc_bp.route('/documents/<doc_id>/lock', methods=['POST'])
@require_auth
def lock_document(doc_id):
    uid = session['user_id']
    conn = get_db()
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    if row['lock_owner_id'] and row['lock_owner_id'] != uid:
        return jsonify({'error': 'Document is locked by another user'}), 423
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("UPDATE documents SET lock_owner_id = ?, locked_at = ? WHERE id = ?", (uid, now, doc_id))
    conn.commit()
    return jsonify({'id': doc_id, 'lockOwnerId': uid})

@doc_bp.route('/documents/<doc_id>/lock', methods=['DELETE'])
@require_auth
def unlock_document(doc_id):
    uid = session['user_id']
    conn = get_db()
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    if row['lock_owner_id'] and row['lock_owner_id'] != uid:
        return jsonify({'error': 'You do not own this lock'}), 403
    conn.execute("UPDATE documents SET lock_owner_id = NULL, locked_at = NULL WHERE id = ?", (doc_id,))
    conn.commit()
    return jsonify({'ok': True})
