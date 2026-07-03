#!/usr/bin/env python3
"""Tests for MD Review app."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'server'))

from config import Config
Config.DATABASE = os.path.join(tempfile.mkdtemp(prefix='md_review_test_app_'), 'test.db')
Config.REPO_ROOT = tempfile.mkdtemp(prefix='md_review_storage_')
Config.SESSION_FILE_DIR = tempfile.mkdtemp(prefix='md_review_session_')
from models import get_db, init_db, ensure_user
from run import create_app
from utils.diff import compute_diff
from utils.renderer import markdown_to_html

APP = create_app()
CLIENT = APP.test_client()


def test_init_db():
    db = init_db()
    tables = [row['name'] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    for name in ('users', 'projects', 'file_versions', 'project_shares'):
        assert name in tables, f"{name} missing"
    db.close()
    print("PASS: init_db")


def test_ensure_user():
    with APP.app_context():
        uid = ensure_user('alice')
        assert uid
        uid2 = ensure_user('alice')
        assert uid == uid2
        row = get_db().execute("SELECT username FROM users WHERE id = ?", (uid,)).fetchone()
        assert row['username'] == 'alice'
    print("PASS: ensure_user")


def test_identifier_login_flow():
    response = CLIENT.get('/api/auth/me')
    assert response.status_code == 401

    response = CLIENT.post('/api/auth/login', json={'username': 'alice'})
    assert response.status_code == 200, response.data
    payload = response.get_json()
    assert payload['user']['username'] == 'alice'

    response = CLIENT.get('/api/auth/bootstrap')
    assert response.status_code == 200
    assert response.get_json()['user']['username'] == 'alice'

    response = CLIENT.post('/api/auth/logout')
    assert response.status_code == 200

    response = CLIENT.get('/api/auth/me')
    assert response.status_code == 401
    print("PASS: identifier_login_flow")


def test_invalid_identifier_rejected():
    response = CLIENT.post('/api/auth/login', json={'username': ''})
    assert response.status_code == 400
    response = CLIENT.post('/api/auth/login', json={'username': 'bad name'})
    assert response.status_code == 400
    print("PASS: invalid_identifier_rejected")


def test_index_exposes_repo_actions():
    response = CLIENT.get('/')
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'btn-download-repo' in html
    print("PASS: index_exposes_repo_actions")


def test_diff_and_renderer():
    diff = compute_diff("alpha beta\n", "alpha gamma\n")
    removed = next(row for row in diff if row['type'] == 'removed')
    added = next(row for row in diff if row['type'] == 'added')
    assert removed['segments'][1]['text'] == 'beta'
    assert added['segments'][1]['text'] == 'gamma'

    html = markdown_to_html("# Title\n\n- one\n- two\n")
    assert '<h1>Title</h1>' in html
    assert '<ul>' in html
    print("PASS: diff_and_renderer")


if __name__ == '__main__':
    test_init_db()
    test_ensure_user()
    test_identifier_login_flow()
    test_invalid_identifier_rejected()
    test_index_exposes_repo_actions()
    test_diff_and_renderer()
    print("ALL PASS")
