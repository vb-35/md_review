#!/usr/bin/env python3
"""Quick integration test."""
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
other_client = app.test_client()
doc_id = None
version_ids = []


def cleanup():
    shutil.rmtree(TMP_DIR, ignore_errors=True)


try:
    # 1. Login in PAM mode
    r = client.post('/api/auth/login', json={'username': 'tester', 'password': 'abc'})
    assert r.status_code == 200, f"login {r.data}"
    print("PASS: login")

    # 2. Session
    r = client.get('/api/auth/me')
    assert r.status_code == 200
    assert r.get_json()['username'] == 'tester'
    print("PASS: me")

    # 3. Bootstrap existing session
    r = client.get('/api/auth/bootstrap')
    assert r.status_code == 200
    assert r.get_json()['user']['username'] == 'tester'
    print("PASS: bootstrap_existing_session")

    # 4. Create doc
    r = client.post('/api/documents', json={'title': 'D1', 'markdown': '# H1\n\n$I=V/R$'})
    assert r.status_code == 201
    doc_id = r.get_json()['id']
    print("PASS: create_doc")

    # 5. Get doc
    r = client.get(f'/api/documents/{doc_id}')
    assert r.status_code == 200
    assert r.get_json()['markdown'] == '# H1\n\n$I=V/R$'
    print("PASS: get_doc")

    # 6. Update doc
    r = client.put(f'/api/documents/{doc_id}', json={'markdown': '# Updated'})
    assert r.status_code == 200
    assert r.get_json()['markdown'] == '# Updated'
    print("PASS: update_doc")

    # 7. Version rows exist
    with app.app_context():
        version_count = get_db().execute(
            "SELECT COUNT(*) FROM document_versions WHERE document_id = ?",
            (doc_id,)
        ).fetchone()[0]
        assert version_count == 2
    print("PASS: version_rows")

    # 8. List versions
    r = client.get(f'/api/documents/{doc_id}/versions')
    assert r.status_code == 200
    versions = r.get_json()
    assert len(versions) == 2
    version_ids = [v['id'] for v in versions]
    print("PASS: list_versions")

    # 9. Compare versions
    r = client.post('/api/versions', json={
        'documentId': doc_id,
        'versionA': version_ids[1],
        'versionB': version_ids[0]
    })
    assert r.status_code == 200
    diff = r.get_json()['diff']
    assert any(x['type'] in ('added', 'removed') for x in diff)
    print(f"PASS: compare_versions ({len(diff)} diff lines)")

    # 10. Revert version
    r = client.post(f'/api/versions/{version_ids[1]}/revert')
    assert r.status_code == 200
    r = client.get(f'/api/documents/{doc_id}')
    assert r.status_code == 200
    assert r.get_json()['markdown'] == '# H1\n\n$I=V/R$'
    print("PASS: revert_version")

    # 11. Comments
    r = client.post('/api/comments/threads', json={'documentId': doc_id, 'anchor': {'startLine': 1, 'endLine': 1}})
    assert r.status_code == 201
    tid = r.get_json()['id']
    r2 = client.post('/api/comment-lines', json={'threadId': tid, 'body': 'Great work'})
    assert r2.status_code == 201
    print("PASS: comments")

    # 12. Lock
    r = client.post(f'/api/documents/{doc_id}/lock')
    assert r.status_code == 200
    print("PASS: lock_doc")

    # 13. Ownership is enforced across users
    r = other_client.post('/api/auth/login', json={'username': 'other', 'password': 'abc'})
    assert r.status_code == 200
    r = other_client.get('/api/documents')
    assert r.status_code == 200
    assert all(doc['id'] != doc_id for doc in r.get_json())
    r = other_client.get(f'/api/documents/{doc_id}')
    assert r.status_code == 404
    r = other_client.get(f'/api/documents/{doc_id}/versions')
    assert r.status_code == 404
    print("PASS: doc_ownership_enforced")

    # 14. Trusted-user bootstrap creates a session
    client.post('/api/auth/logout')
    Config.AUTH_MODE = 'trusted_user'
    r = client.get('/api/auth/bootstrap', headers={'X-Remote-User': 'alice'})
    assert r.status_code == 200
    assert r.get_json()['user']['username'] == 'alice'
    r = client.get('/api/auth/me')
    assert r.status_code == 200
    assert r.get_json()['username'] == 'alice'
    print("PASS: bootstrap_trusted_user")

    # 15. Missing trusted header returns 401
    client.post('/api/auth/logout')
    r = client.get('/api/auth/bootstrap')
    assert r.status_code == 401
    print("PASS: bootstrap_missing_header")

    # 16. Non-local trusted header is rejected
    r = client.get(
        '/api/auth/bootstrap',
        headers={'X-Remote-User': 'mallory'},
        environ_overrides={'REMOTE_ADDR': '10.0.0.5'}
    )
    assert r.status_code == 401
    print("PASS: bootstrap_rejects_non_local")

    # 17. Token login creates a session
    client.post('/api/auth/logout')
    token = issue_login_token('carol')
    r = client.post('/api/auth/token-login', json={'token': token})
    assert r.status_code == 200
    assert r.get_json()['user']['username'] == 'carol'
    r = client.get('/api/auth/me')
    assert r.status_code == 200
    assert r.get_json()['username'] == 'carol'
    print("PASS: token_login")

    # 18. Permanent token login creates a session for a separate regular user
    client.post('/api/auth/logout')
    r = client.post('/api/auth/token-login', json={'token': Config.PERMANENT_ADMIN_TOKEN})
    assert r.status_code == 200
    assert r.get_json()['user']['username'] == Config.PERMANENT_ADMIN_USERNAME
    r = client.get('/api/auth/me')
    assert r.status_code == 200
    assert r.get_json()['username'] == Config.PERMANENT_ADMIN_USERNAME
    print("PASS: permanent_token_login")

    # 19. Invalid token is rejected
    client.post('/api/auth/logout')
    r = client.post('/api/auth/token-login', json={'token': 'not-a-real-token'})
    assert r.status_code == 401
    print("PASS: token_login_rejects_invalid")

    # 20. Password login still works in PAM mode
    Config.AUTH_MODE = 'pam'
    Config.LOCAL_AUTH = 'on'
    client.post('/api/auth/logout')
    r = client.post('/api/auth/login', json={'username': 'bob', 'password': '123'})
    assert r.status_code == 200
    assert r.get_json()['user']['username'] == 'bob'
    print("PASS: pam_login_still_works")

    # 21. Markdown render
    from utils.renderer import markdown_to_html
    h = markdown_to_html('# Title\n\n$E=mc^2$\n\n- a\n- b\n```python\nprint(1)\n```')
    assert '<h1>' in h
    assert 'math-inline' in h
    assert '<ul>' in h
    assert '<pre>' in h
    print("PASS: markdown_render")

    print("\nAll 21 tests passed!")
finally:
    cleanup()
