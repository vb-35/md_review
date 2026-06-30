#!/usr/bin/env python3
"""Quick integration test."""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'server'))

from config import Config
from models import init_db, get_db
from run import create_app
from utils.login_tokens import issue_login_token


TMP_DIR = tempfile.mkdtemp(prefix='md_review_test_')
Config.DATABASE = os.path.join(TMP_DIR, 'test_quick.db')
Config.SESSION_FILE_DIR = os.path.join(TMP_DIR, 'sessions')
Config.SECRET_KEY = 'test-secret'
Config.AUTH_MODE = 'pam'
Config.LOCAL_AUTH = 'on'
Config.TRUSTED_USER_HEADER = 'X-Remote-User'
Config.TRUSTED_USER_LOCAL_ONLY = True

os.makedirs(Config.SESSION_FILE_DIR, exist_ok=True)
init_db()
app = create_app()
client = app.test_client()
viewer_client = app.test_client()
editor_client = app.test_client()
other_client = app.test_client()
doc_id = None
version_ids = []


def cleanup():
    shutil.rmtree(TMP_DIR, ignore_errors=True)


try:
    r = client.post('/api/auth/login', json={'username': 'tester', 'password': 'abc'})
    assert r.status_code == 200, f"login {r.data}"
    print("PASS: login")

    r = viewer_client.post('/api/auth/login', json={'username': 'viewer', 'password': 'abc'})
    assert r.status_code == 200
    print("PASS: viewer_login")

    r = editor_client.post('/api/auth/login', json={'username': 'editor', 'password': 'abc'})
    assert r.status_code == 200
    print("PASS: editor_login")

    r = other_client.post('/api/auth/login', json={'username': 'other', 'password': 'abc'})
    assert r.status_code == 200
    print("PASS: other_login")

    r = client.get('/api/auth/me')
    assert r.status_code == 200
    assert r.get_json()['username'] == 'tester'
    print("PASS: me")

    r = client.get('/api/auth/bootstrap')
    assert r.status_code == 200
    assert r.get_json()['user']['username'] == 'tester'
    print("PASS: bootstrap_existing_session")

    r = client.post('/api/documents', json={'title': 'D1', 'markdown': '# H1\n\n$I=V/R$'})
    assert r.status_code == 201
    doc = r.get_json()
    doc_id = doc['id']
    assert doc['accessRole'] == 'owner'
    assert doc['isOwner'] is True
    print("PASS: create_doc")

    r = client.get(f'/api/documents/{doc_id}')
    assert r.status_code == 200
    assert r.get_json()['markdown'] == '# H1\n\n$I=V/R$'
    assert r.get_json()['ownerUsername'] == 'tester'
    print("PASS: get_doc")

    r = client.put(f'/api/documents/{doc_id}', json={'markdown': '# Updated'})
    assert r.status_code == 200
    assert r.get_json()['markdown'] == '# Updated'
    print("PASS: update_doc")

    with app.app_context():
        version_count = get_db().execute(
            "SELECT COUNT(*) FROM document_versions WHERE document_id = ?",
            (doc_id,)
        ).fetchone()[0]
        assert version_count == 2
    print("PASS: version_rows")

    r = client.get(f'/api/documents/{doc_id}/versions')
    assert r.status_code == 200
    versions = r.get_json()
    assert len(versions) == 2
    version_ids = [v['id'] for v in versions]
    print("PASS: list_versions")

    r = client.post('/api/versions', json={
        'documentId': doc_id,
        'versionA': version_ids[1],
        'versionB': version_ids[0]
    })
    assert r.status_code == 200
    diff = r.get_json()['diff']
    assert any(x['type'] in ('added', 'removed') for x in diff)
    assert any('segments' in x for x in diff if x['type'] in ('added', 'removed'))
    print(f"PASS: compare_versions ({len(diff)} diff lines)")

    with app.app_context():
        stored_diff = get_db().execute(
            "SELECT diff FROM document_versions WHERE id = ?",
            (version_ids[0],)
        ).fetchone()['diff']
        parsed_diff = json.loads(stored_diff)
        assert isinstance(parsed_diff, list)
        assert all(not isinstance(row, str) for row in parsed_diff)
    print("PASS: stored_diff_json")

    r = client.post(f'/api/documents/{doc_id}/shares', json={'username': 'viewer', 'role': 'viewer'})
    assert r.status_code == 200
    assert r.get_json()['role'] == 'viewer'
    print("PASS: share_doc_viewer")

    r = client.post(f'/api/documents/{doc_id}/shares', json={'username': 'editor', 'role': 'editor'})
    assert r.status_code == 200
    assert r.get_json()['role'] == 'editor'
    print("PASS: share_doc_editor")

    r = client.post(f'/api/documents/{doc_id}/shares', json={'username': 'missing', 'role': 'viewer'})
    assert r.status_code == 404
    print("PASS: share_missing_user_rejected")

    r = client.get(f'/api/documents/{doc_id}/shares')
    assert r.status_code == 200
    shares = r.get_json()
    assert {s['username'] for s in shares} == {'viewer', 'editor'}
    print("PASS: list_shares")

    r = viewer_client.get('/api/documents')
    assert r.status_code == 200
    viewer_docs = r.get_json()
    assert any(d['id'] == doc_id and d['accessRole'] == 'viewer' for d in viewer_docs)
    print("PASS: viewer_list_shared_doc")

    r = viewer_client.get(f'/api/documents/{doc_id}')
    assert r.status_code == 200
    assert r.get_json()['accessRole'] == 'viewer'
    print("PASS: viewer_get_doc")

    r = viewer_client.get(f'/api/documents/{doc_id}/versions')
    assert r.status_code == 200
    print("PASS: viewer_list_versions")

    r = viewer_client.get(f'/api/documents/{doc_id}/threads')
    assert r.status_code == 200
    print("PASS: viewer_list_threads")

    r = viewer_client.put(f'/api/documents/{doc_id}', json={'markdown': '# No'})
    assert r.status_code == 403
    r = viewer_client.post(f'/api/documents/{doc_id}/lock')
    assert r.status_code == 403
    r = viewer_client.post(f'/api/versions/{version_ids[1]}/revert')
    assert r.status_code == 403
    r = viewer_client.get(f'/api/documents/{doc_id}/shares')
    assert r.status_code == 403
    print("PASS: viewer_write_access_blocked")

    r = viewer_client.post('/api/comments/threads', json={'documentId': doc_id, 'body': 'Viewer note'})
    assert r.status_code == 201
    viewer_thread_id = r.get_json()['id']
    r = viewer_client.post('/api/comment-lines', json={'threadId': viewer_thread_id, 'body': 'Viewer reply'})
    assert r.status_code == 201
    r = viewer_client.post(f'/api/comments/threads/{viewer_thread_id}/resolve')
    assert r.status_code == 403
    print("PASS: viewer_can_comment_but_not_resolve")

    r = editor_client.get(f'/api/documents/{doc_id}')
    assert r.status_code == 200
    assert r.get_json()['accessRole'] == 'editor'
    print("PASS: editor_get_doc")

    r = editor_client.post(f'/api/documents/{doc_id}/lock')
    assert r.status_code == 200
    assert r.get_json()['lockOwnerId']
    print("PASS: editor_lock_doc")

    r = editor_client.put(f'/api/documents/{doc_id}', json={'markdown': '# Editor Updated'})
    assert r.status_code == 200
    assert r.get_json()['markdown'] == '# Editor Updated'
    print("PASS: editor_update_doc")

    r = editor_client.post('/api/comments/threads', json={
        'documentId': doc_id,
        'anchor': {
            'startLine': 1,
            'endLine': 1,
            'startOffset': 2,
            'endOffset': 8,
            'selectedText': 'Editor'
        }
    })
    assert r.status_code == 201
    tid = r.get_json()['id']
    listed = editor_client.get(f'/api/documents/{doc_id}/threads')
    assert listed.status_code == 200
    anchor = next(t['anchor'] for t in listed.get_json() if t['id'] == tid)
    assert anchor['startLine'] == 1
    assert anchor['endLine'] == 1
    assert anchor['startOffset'] == 2
    assert anchor['endOffset'] == 8
    assert anchor['selectedText'] == 'Editor'
    r2 = editor_client.post('/api/comment-lines', json={'threadId': tid, 'body': 'Great work'})
    assert r2.status_code == 201
    r3 = editor_client.post(f'/api/comments/threads/{tid}/resolve')
    assert r3.status_code == 200
    print("PASS: editor_comments_and_resolve")

    r = editor_client.post(f'/api/versions/{version_ids[1]}/revert')
    assert r.status_code == 200
    print("PASS: editor_revert_version")

    r = editor_client.get(f'/api/documents/{doc_id}/shares')
    assert r.status_code == 403
    r = editor_client.delete(f"/api/documents/{doc_id}/shares/{shares[0]['userId']}")
    assert r.status_code == 403
    r = editor_client.delete(f'/api/documents/{doc_id}')
    assert r.status_code == 403
    print("PASS: editor_owner_actions_blocked")

    r = client.post(f'/api/documents/{doc_id}/shares', json={'username': 'viewer', 'role': 'editor'})
    assert r.status_code == 200
    assert r.get_json()['role'] == 'editor'
    r = client.get(f'/api/documents/{doc_id}/shares')
    viewer_share = next(s for s in r.get_json() if s['username'] == 'viewer')
    r = client.delete(f"/api/documents/{doc_id}/shares/{viewer_share['userId']}")
    assert r.status_code == 200
    print("PASS: owner_update_and_revoke_share")

    r = viewer_client.get(f'/api/documents/{doc_id}')
    assert r.status_code == 404
    print("PASS: revoked_viewer_loses_access")

    r = other_client.get('/api/documents')
    assert r.status_code == 200
    assert all(doc['id'] != doc_id for doc in r.get_json())
    r = other_client.get(f'/api/documents/{doc_id}')
    assert r.status_code == 404
    r = other_client.get(f'/api/documents/{doc_id}/versions')
    assert r.status_code == 404
    print("PASS: unrelated_user_blocked")

    client.post('/api/auth/logout')
    Config.AUTH_MODE = 'trusted_user'
    r = client.get('/api/auth/bootstrap', headers={'X-Remote-User': 'alice'})
    assert r.status_code == 200
    assert r.get_json()['user']['username'] == 'alice'
    r = client.get('/api/auth/me')
    assert r.status_code == 200
    assert r.get_json()['username'] == 'alice'
    print("PASS: bootstrap_trusted_user")

    client.post('/api/auth/logout')
    r = client.get('/api/auth/bootstrap')
    assert r.status_code == 401
    print("PASS: bootstrap_missing_header")

    r = client.get(
        '/api/auth/bootstrap',
        headers={'X-Remote-User': 'mallory'},
        environ_overrides={'REMOTE_ADDR': '10.0.0.5'}
    )
    assert r.status_code == 401
    print("PASS: bootstrap_rejects_non_local")

    client.post('/api/auth/logout')
    token = issue_login_token('carol')
    r = client.post('/api/auth/token-login', json={'token': token})
    assert r.status_code == 200
    assert r.get_json()['user']['username'] == 'carol'
    r = client.get('/api/auth/me')
    assert r.status_code == 200
    assert r.get_json()['username'] == 'carol'
    print("PASS: token_login")

    token_client = app.test_client()
    token = issue_login_token('dave')
    r = token_client.get(f'/api/auth/bootstrap?token={token}')
    assert r.status_code == 200
    assert r.get_json()['user']['username'] == 'dave'
    r = token_client.get('/api/auth/me')
    assert r.status_code == 200
    assert r.get_json()['username'] == 'dave'
    print("PASS: bootstrap_token_login")

    client.post('/api/auth/logout')
    r = client.post('/api/auth/token-login', json={'token': Config.PERMANENT_ADMIN_TOKEN})
    assert r.status_code == 200
    assert r.get_json()['user']['username'] == Config.PERMANENT_ADMIN_USERNAME
    r = client.get('/api/auth/me')
    assert r.status_code == 200
    assert r.get_json()['username'] == Config.PERMANENT_ADMIN_USERNAME
    print("PASS: permanent_token_login")

    client.post('/api/auth/logout')
    r = client.post('/api/auth/token-login', json={'token': 'not-a-real-token'})
    assert r.status_code == 401
    print("PASS: token_login_rejects_invalid")

    Config.AUTH_MODE = 'pam'
    Config.LOCAL_AUTH = 'on'
    client.post('/api/auth/logout')
    r = client.post('/api/auth/login', json={'username': 'bob', 'password': '123'})
    assert r.status_code == 200
    assert r.get_json()['user']['username'] == 'bob'
    print("PASS: pam_login_still_works")

    from utils.renderer import markdown_to_html
    h = markdown_to_html('# Title\n\n$E=mc^2$\n\n- a\n- b\n```python\nprint(1)\n```')
    assert '<h1>' in h
    assert 'math-inline' in h
    assert '<ul>' in h
    assert '<pre>' in h
    print("PASS: markdown_render")

    print("\nAll tests passed!")
finally:
    cleanup()
