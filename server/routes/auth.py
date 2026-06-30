from flask import Blueprint, request, jsonify, session

from utils.pam_auth import authenticate
from models import ensure_user

auth_bp = Blueprint('auth', __name__)

@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.get_json()
    if not data or 'username' not in data or 'password' not in data:
        return jsonify({'error': 'username and password required'}), 400

    result = authenticate(data['username'], data['password'])
    if not result['success']:
        return jsonify({'error': 'Invalid credentials'}), 401

    uid = ensure_user(data['username'])
    session['user_id'] = uid
    session['username'] = data['username']
    return jsonify({'user': {'id': uid, 'username': data['username']}})

@auth_bp.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'ok': True})

@auth_bp.route('/me', methods=['GET'])
def me():
    if 'user_id' not in session:
        return jsonify({'error': 'Not authenticated'}), 401
    return jsonify({'id': session['user_id'], 'username': session['username']})
