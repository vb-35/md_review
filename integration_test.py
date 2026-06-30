#!/usr/bin/env python3
"""Quick integration test."""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'server'))
from config import Config
Config.DATABASE = 'test_quick.db'
from models import init_db, get_db
from run import create_app

init_db()
app = create_app()
client = app.test_client()
fails = 0
doc_id = None
cs_id = None

# 1. Login
r = client.post('/api/auth/login', json={'username':'tester','password':'abc'})
assert r.status_code == 200, f"login {r.data}"
print("PASS: login")

# 2. Session
r = client.get('/api/auth/me')
assert r.status_code == 200
assert r.get_json()['username'] == 'tester'
print("PASS: me")

# 3. Create doc
r = client.post('/api/documents', json={'title':'D1','markdown':'# H1\n\n$I=V/R$'})
assert r.status_code == 201
doc_id = r.get_json()['id']
print("PASS: create_doc")

# 4. Get doc
r = client.get(f'/api/documents/{doc_id}')
assert r.status_code == 200
assert r.get_json()['markdown'] == '# H1\n\n$I=V/R$'
print("PASS: get_doc")

# 5. Update doc (overwrite)
r = client.put(f'/api/documents/{doc_id}', json={'markdown':'# Updated'})
assert r.status_code == 200
assert r.get_json()['markdown'] == '# Updated'
print("PASS: update_doc_overwrite")

# 6. No version rows
with app.app_context():
    cs = get_db().execute("SELECT COUNT(*) FROM change_sets").fetchone()[0]
    assert cs == 0
print("PASS: no_version_rows")

# 7. Create change set
r = client.post('/api/change-sets', json={'documentId': doc_id, 'candidateMarkdown': '# New\ncandidate.'})
assert r.status_code == 201
cs = r.get_json()
diff = json.loads(cs['diff'])
assert any(x['type'] in ('added','removed') for x in diff)
cs_id = cs['id']
print(f"PASS: change_set ({len(diff)} diff lines)")

# 8. Accept change set
r = client.post(f'/api/change-sets/{cs_id}/review', json={'action':'accept'})
assert r.status_code == 200
assert r.get_json()['status'] == 'accepted'
print("PASS: accept_changeset")

# 9. Reject change set
r = client.post('/api/change-sets', json={'documentId': doc_id, 'candidateMarkdown': '# reject me'})
rj_cs_id = r.get_json()['id']
r2 = client.post(f'/api/change-sets/{rj_cs_id}/review', json={'action':'reject'})
assert r2.status_code == 200
assert r2.get_json()['status'] == 'rejected'
print("PASS: reject_changeset")

# 10. Comments
r = client.post('/api/comments/threads', json={'documentId': doc_id, 'anchor':{'startLine':1,'endLine':1}})
assert r.status_code == 201
tid = r.get_json()['id']
r2 = client.post('/api/comment-lines', json={'threadId': tid, 'body': 'Great work'})
assert r2.status_code == 201
print("PASS: comments")

# 11. Lock
r = client.post(f'/api/documents/{doc_id}/lock')
assert r.status_code == 200
print("PASS: lock_doc")

# 12. Markdown render
from utils.renderer import markdown_to_html
h = markdown_to_html('# Title\n\n$E=mc^2$\n\n- a\n- b\n```python\nprint(1)\n```')
assert '<h1>' in h
assert 'math-inline' in h
assert '<ul>' in h
assert '<pre>' in h
print("PASS: markdown_render")

print("\nAll 12 tests passed!")
os.remove(Config.DATABASE)
