#!/usr/bin/env python3
"""Tests for MD Review app."""
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'server'))

from config import Config
Config.DATABASE = os.path.join(tempfile.mkdtemp(prefix='md_review_test_app_'), 'test.db')
Config.REPO_ROOT = tempfile.mkdtemp(prefix='md_review_storage_')
Config.SESSION_FILE_DIR = tempfile.mkdtemp(prefix='md_review_session_')
from models import get_db, init_db, ensure_user
from run import create_app
from utils.diff import apply_diff_chunk, apply_diff_decisions, compute_diff
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
    assert 'replace-shortcut-select' in html
    assert 'font-size-select' in html
    assert 'find-replace-bar' in html
    print("PASS: index_exposes_repo_actions")


def test_find_replace_js_helpers():
    if not shutil.which('node'):
        print("SKIP: find_replace_js_helpers (node not installed)")
        return
    subprocess.run(
        ['node', '--check', os.path.join(os.path.dirname(__file__), 'webapp/js/find-replace.js')],
        check=True,
        capture_output=True,
        text=True
    )
    print("PASS: find_replace_js_helpers")


def test_comments_js_helpers():
    if not shutil.which('node'):
        print("SKIP: comments_js_helpers (node not installed)")
        return
    result = subprocess.run(
        ['node', os.path.join(os.path.dirname(__file__), 'webapp/js/comments.test.js')],
        check=True,
        capture_output=True,
        text=True
    )
    assert 'PASS: comments sorting helpers' in result.stdout
    print("PASS: comments_js_helpers")


def test_diff_and_renderer():
    diff = compute_diff("alpha beta\n", "alpha gamma\n")
    removed = next(row for row in diff if row['type'] == 'removed')
    added = next(row for row in diff if row['type'] == 'added')
    assert removed['rowId']
    changed_removed = next(segment for segment in removed['segments'] if segment['changed'])
    changed_added = next(segment for segment in added['segments'] if segment['changed'])
    assert changed_removed['text'] == 'beta'
    assert changed_added['text'] == 'gamma'
    assert changed_removed['chunkId'] == removed['chunks'][0]['chunkId']
    assert changed_added['chunkId'] == added['chunks'][0]['chunkId']

    html = markdown_to_html("# Title\n\n- one\n- two\n")
    assert '<h1>Title</h1>' in html
    assert '<ul>' in html
    print("PASS: diff_and_renderer")


def test_apply_diff_chunk_replace_and_conflict():
    base = "alpha beta\ngamma delta\n"
    candidate = "alpha gamma\ngamma theta\n"
    diff = compute_diff(base, candidate)
    removed = next(row for row in diff if row['type'] == 'removed')
    first_chunk = removed['chunks'][0]

    accepted = apply_diff_chunk(base, candidate, base, removed['rowId'], first_chunk['chunkId'], 'accept')
    assert accepted['content'] == "alpha gamma\ngamma delta\n"

    refused = apply_diff_chunk(base, candidate, candidate, removed['rowId'], first_chunk['chunkId'], 'refuse')
    assert refused['content'] == "alpha beta\ngamma theta\n"

    accepted_noop = apply_diff_chunk(base, candidate, candidate, removed['rowId'], first_chunk['chunkId'], 'accept')
    assert accepted_noop['content'] == candidate
    print("PASS: apply_diff_chunk_replace_and_conflict")


def test_apply_diff_chunk_line_add_remove():
    added_diff = compute_diff("alpha\n", "alpha\nbeta\n")
    added_row = next(row for row in added_diff if row['type'] == 'added')
    added_chunk = added_row['chunks'][0]
    accepted_add = apply_diff_chunk("alpha\n", "alpha\nbeta\n", "alpha\n", added_row['rowId'], added_chunk['chunkId'], 'accept')
    assert accepted_add['content'] == "alpha\nbeta\n"

    removed_diff = compute_diff("alpha\nbeta\n", "alpha\n")
    removed_row = next(row for row in removed_diff if row['type'] == 'removed')
    removed_chunk = removed_row['chunks'][0]
    accepted_remove = apply_diff_chunk("alpha\nbeta\n", "alpha\n", "alpha\nbeta\n", removed_row['rowId'], removed_chunk['chunkId'], 'accept')
    assert accepted_remove['content'] == "alpha\n"
    print("PASS: apply_diff_chunk_line_add_remove")


def test_apply_diff_decisions_allows_flip_and_old_version_fallback():
    base = "# 4. Method\n\n## 4.1 Method overview\n\nParagraph\n\n## 4.2 Architecture\n"
    candidate = "# 4. Method\n## 4.1 Method overview\nParagraph\ndzd\n## 4.2 Architecture\n"
    current = candidate
    diff = compute_diff(base, candidate)
    added = next(row for row in diff if row['type'] == 'added' and row['line'] == 'dzd')
    decision = {'rowId': added['rowId'], 'chunkId': added['chunks'][0]['chunkId'], 'decision': 'refuse'}
    refused = apply_diff_decisions(base, candidate, current, [decision])
    assert refused['content'] == "# 4. Method\n## 4.1 Method overview\nParagraph\n\n## 4.2 Architecture\n"

    accepted = apply_diff_decisions(base, candidate, current, [{
        'rowId': added['rowId'],
        'chunkId': added['chunks'][0]['chunkId'],
        'decision': 'accept',
    }])
    assert accepted['content'] == candidate
    print("PASS: apply_diff_decisions_allows_flip_and_old_version_fallback")


if __name__ == '__main__':
    test_init_db()
    test_ensure_user()
    test_identifier_login_flow()
    test_invalid_identifier_rejected()
    test_index_exposes_repo_actions()
    test_find_replace_js_helpers()
    test_comments_js_helpers()
    test_diff_and_renderer()
    test_apply_diff_chunk_replace_and_conflict()
    test_apply_diff_chunk_line_add_remove()
    test_apply_diff_decisions_allows_flip_and_old_version_fallback()
    print("ALL PASS")
