import ipaddress
import re

from flask import Blueprint, request, jsonify, session

from config import Config
from utils.pam_auth import authenticate
from utils.login_tokens import verify_any_login_token
from models import ensure_user

auth_bp = Blueprint('auth', __name__)
USERNAME_RE = re.compile(r'^[A-Za-z0-9._@-]{1,128}$')

def is_password_login_enabled():
    return Config.AUTH_MODE in ('pam', 'mixed')

def current_user_payload():
    return {'id': session['user_id'], 'username': session['username']}

def login_user(username):
    uid = ensure_user(username)
    session['user_id'] = uid
    session['username'] = username
    return {'id': uid, 'username': username}

def is_local_request():
    remote_addr = (request.remote_addr or '').strip()
    if not remote_addr:
        return False
    try:
        return ipaddress.ip_address(remote_addr).is_loopback
    except ValueError:
        return remote_addr == 'localhost'

def normalize_trusted_username(raw_username):
    username = (raw_username or '').strip()
    if not username:
        return None
    if not USERNAME_RE.fullmatch(username):
        return None
    return username

def get_trusted_username():
    if Config.AUTH_MODE not in ('trusted_user', 'mixed'):
        return None, 'Trusted-user auth is disabled'
    if Config.TRUSTED_USER_LOCAL_ONLY and not is_local_request():
        return None, 'Trusted-user auth is only accepted from local requests'
    username = normalize_trusted_username(request.headers.get(Config.TRUSTED_USER_HEADER))
    if not username:
        return None, f'Missing trusted user header {Config.TRUSTED_USER_HEADER}'
    return username, None

@auth_bp.route('/login', methods=['POST'])
def login():
    if not is_password_login_enabled():
        return jsonify({'error': 'Password login is disabled', 'authMode': Config.AUTH_MODE}), 403

    data = request.get_json()
    if not data or 'username' not in data or 'password' not in data:
        return jsonify({'error': 'username and password required'}), 400

    result = authenticate(data['username'], data['password'])
    if not result['success']:
        return jsonify({'error': 'Invalid credentials'}), 401

    return jsonify({'user': login_user(data['username'])})

@auth_bp.route('/bootstrap', methods=['GET'])
def bootstrap():
    if 'user_id' in session:
        return jsonify({
            'user': current_user_payload(),
            'authMode': Config.AUTH_MODE,
            'passwordLoginEnabled': is_password_login_enabled()
        })

    username, error = get_trusted_username()
    if username:
        return jsonify({
            'user': login_user(username),
            'authMode': Config.AUTH_MODE,
            'passwordLoginEnabled': is_password_login_enabled()
        })

    return jsonify({
        'error': error or 'Not authenticated',
        'authMode': Config.AUTH_MODE,
        'passwordLoginEnabled': is_password_login_enabled()
    }), 401

@auth_bp.route('/token-login', methods=['POST'])
def token_login():
    data = request.get_json()
    if not data or 'token' not in data:
        return jsonify({'error': 'token required'}), 400

    token_payload, error = verify_any_login_token(data['token'])
    if error or not token_payload:
        return jsonify({'error': error}), 401

    username = normalize_trusted_username(token_payload['username'])
    if not username:
        return jsonify({'error': 'Invalid login token'}), 401

    return jsonify({
        'user': login_user(username),
        'authMode': Config.AUTH_MODE,
        'passwordLoginEnabled': is_password_login_enabled()
    })

@auth_bp.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'ok': True})

@auth_bp.route('/me', methods=['GET'])
def me():
    if 'user_id' not in session:
        return jsonify({'error': 'Not authenticated'}), 401
    return jsonify(current_user_payload())
