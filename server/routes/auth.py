import re

from flask import Blueprint, request, jsonify, session

from models import ensure_user

auth_bp = Blueprint('auth', __name__)
USERNAME_RE = re.compile(r'^[A-Za-z0-9._@-]{1,128}$')

def current_user_payload():
    return {'id': session['user_id'], 'username': session['username']}

def login_user(username):
    uid = ensure_user(username)
    session['user_id'] = uid
    session['username'] = username
    return {'id': uid, 'username': username}

def normalize_trusted_username(raw_username):
    username = (raw_username or '').strip()
    if not username:
        return None
    if not USERNAME_RE.fullmatch(username):
        return None
    return username

@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.get_json()
    username = normalize_trusted_username((data or {}).get('username'))
    if not username:
        return jsonify({'error': 'Valid username required'}), 400
    return jsonify({'user': login_user(username)})

@auth_bp.route('/bootstrap', methods=['GET'])
def bootstrap():
    if 'user_id' in session:
        return jsonify({'user': current_user_payload()})
    return jsonify({'error': 'Not authenticated'}), 401

@auth_bp.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'ok': True})

@auth_bp.route('/me', methods=['GET'])
def me():
    if 'user_id' not in session:
        return jsonify({'error': 'Not authenticated'}), 401
    return jsonify(current_user_payload())
