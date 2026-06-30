#!/usr/bin/env python3
"""Tests for MD Review app."""
import sys, os, json, uuid, tempfile, io, importlib.util
from datetime import datetime, timezone
from contextlib import redirect_stdout
from importlib.machinery import SourceFileLoader
from flask import Flask

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'server'))

from config import Config
Config.DATABASE = os.path.join(tempfile.mkdtemp(prefix='md_review_test_app_'), 'test.db')
from models import get_db, init_db, ensure_user
from run import create_app
from utils.diff import compute_diff
from utils.login_tokens import issue_login_token, verify_login_token
from utils.renderer import markdown_to_html

CTL_PATH = os.path.join(os.path.dirname(__file__), 'md-reviewctl')
CTL_SPEC = importlib.util.spec_from_loader('md_reviewctl', SourceFileLoader('md_reviewctl', CTL_PATH))
md_reviewctl = importlib.util.module_from_spec(CTL_SPEC)
CTL_SPEC.loader.exec_module(md_reviewctl)

app = Flask(__name__)

def test_init_db():
    db = init_db()
    t = [r['name'] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    for name in ('users','documents','change_sets','document_shares','comment_threads','comments','comment_anchors'):
        assert name in t, f"{name} missing"
    db.close()
    print("PASS: init_db")

def test_ensure_user():
    uid = ensure_user('alice')
    assert uid
    uid2 = ensure_user('alice')
    assert uid == uid2
    r = get_db().execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()
    assert r['username'] == 'alice'
    print("PASS: ensure_user")

def test_doc_crud():
    conn = get_db()
    uid = ensure_user('bob')
    did = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("INSERT INTO documents (id,title,markdown,owner_id,updated_by,updated_at) VALUES (?,?,?,?,?,?)",
        (did, 'Doc1', '# Hello', uid, uid, now))
    conn.commit()
    r = conn.execute("SELECT * FROM documents WHERE id=?", (did,)).fetchone()
    assert r['title'] == 'Doc1'
    assert r['markdown'] == '# Hello'
    assert r['owner_id'] == uid
    print("PASS: doc_crud")

def test_doc_overwrite():
    conn = get_db()
    uid = ensure_user('carol')
    did = str(uuid.uuid4())
    conn.execute("INSERT INTO documents (id,title,markdown,owner_id,updated_by,updated_at) VALUES (?,?,?,?,?,?)",
        (did, 'D', 'v1', uid, uid, datetime.now(timezone.utc).isoformat()))
    conn.commit()
    conn.execute("UPDATE documents SET markdown='v2' WHERE id=?", (did,))
    conn.commit()
    r = conn.execute("SELECT markdown FROM documents WHERE id=?", (did,)).fetchone()
    assert r['markdown'] == 'v2'
    assert conn.execute("SELECT COUNT(*) FROM change_sets").fetchone()[0] == 0
    print("PASS: doc_overwrite_no_versions")

def test_signed_login_token():
    payload, error = verify_login_token(issue_login_token('admin'))
    assert error is None
    assert payload['username'] == 'admin'
    assert payload['source'] == 'signed'
    print("PASS: signed_login_token")

def test_cli_token_emits_valid_token():
    token = io.StringIO()
    original_resolve_root = md_reviewctl.resolve_root
    original_token_secret = os.environ.get('TOKEN_LOGIN_SECRET')
    try:
        md_reviewctl.resolve_root = lambda: os.path.dirname(__file__)
        os.environ['TOKEN_LOGIN_SECRET'] = Config.TOKEN_LOGIN_SECRET
        with redirect_stdout(token):
            md_reviewctl.cmd_token(type('Args', (), {'username': None})())
    finally:
        md_reviewctl.resolve_root = original_resolve_root
        if original_token_secret is None:
            os.environ.pop('TOKEN_LOGIN_SECRET', None)
        else:
            os.environ['TOKEN_LOGIN_SECRET'] = original_token_secret
    payload, error = verify_login_token(token.getvalue().strip())
    assert error is None
    assert payload['username']
    print("PASS: cli_token_emits_valid_token")

def test_cli_token_rejects_other_user_without_root():
    original_current_username = md_reviewctl.current_username
    original_is_root = md_reviewctl.is_root
    original_validate_local_user = md_reviewctl.validate_local_user
    try:
        md_reviewctl.current_username = lambda: 'alice'
        md_reviewctl.is_root = lambda: False
        md_reviewctl.validate_local_user = lambda username: None
        try:
            md_reviewctl.cmd_token(type('Args', (), {'username': 'bob'})())
            raise AssertionError('expected SystemExit')
        except SystemExit as exc:
            assert str(exc) == 'Only root may generate a token for another user'
    finally:
        md_reviewctl.current_username = original_current_username
        md_reviewctl.is_root = original_is_root
        md_reviewctl.validate_local_user = original_validate_local_user
    print("PASS: cli_token_rejects_other_user_without_root")

def test_diff_add_change_del():
    base = "a\nb\nc\n"
    cand = "a\nB\nd\n"
    d = compute_diff(base, cand)
    types = [x['type'] for x in d]
    assert 'context' in types
    assert 'added' in types
    assert 'removed' in types
    changed_rows = [x for x in d if x['type'] in ('added', 'removed')]
    assert all('segments' in row for row in changed_rows)
    print("PASS: diff_add_change_del")

def test_diff_empty_base():
    d = compute_diff('', 'x\ny\n')
    assert all(x['type'] == 'added' for x in d)
    print("PASS: diff_empty_base")

def test_diff_word_segments():
    d = compute_diff("alpha beta\n", "alpha gamma\n")
    removed = next(x for x in d if x['type'] == 'removed')
    added = next(x for x in d if x['type'] == 'added')
    assert removed['segments'] == [
        {'text': 'alpha ', 'changed': False},
        {'text': 'beta', 'changed': True},
    ]
    assert added['segments'] == [
        {'text': 'alpha ', 'changed': False},
        {'text': 'gamma', 'changed': True},
    ]
    print("PASS: diff_word_segments")

def test_diff_punctuation_segments():
    d = compute_diff("hello, world!\n", "hello world?\n")
    removed = next(x for x in d if x['type'] == 'removed')
    added = next(x for x in d if x['type'] == 'added')
    assert any(seg['text'] == ',' and seg['changed'] for seg in removed['segments'])
    assert any(seg['text'] == '?' and seg['changed'] for seg in added['segments'])
    print("PASS: diff_punctuation_segments")

def test_diff_whitespace_segments():
    d = compute_diff("a  b\n", "a b\n")
    removed = next(x for x in d if x['type'] == 'removed')
    assert any(seg['text'] == '  ' and seg['changed'] for seg in removed['segments'])
    print("PASS: diff_whitespace_segments")

def test_diff_surplus_lines():
    d = compute_diff("one\ntwo\nthree\n", "one\nTWO\n")
    changed = [x for x in d if x['type'] in ('added', 'removed')]
    assert len(changed) == 3
    assert changed[-1]['type'] == 'removed'
    assert changed[-1]['segments'] == [{'text': 'three', 'changed': True}]
    print("PASS: diff_surplus_lines")

def test_md_headings():
    h = markdown_to_html("# H1\n\n## H2\n\n### H3")
    assert '<h1>H1</h1>' in h
    assert '<h2>H2</h2>' in h
    assert '<h3>H3</h3>' in h
    print("PASS: md_headings")

def test_md_list():
    h = markdown_to_html("- a\n- b\n- c")
    assert '<ul>' in h and '<li>' in h
    print("PASS: md_list")

def test_md_code():
    h = markdown_to_html("```py\nprint(1)\n```")
    assert '<pre>' in h
    print("PASS: md_code")

def test_md_inline_math():
    h = markdown_to_html("Val is $E=mc^2$ today")
    assert 'math-inline' in h
    print("PASS: md_inline_math")

def test_md_table():
    h = markdown_to_html("| A | B |\n|---|---|\n| 1 | 2 |")
    assert '<table>' in h and '<th>' in h and '<td>' in h
    print("PASS: md_table")

def test_comment_anchor_offsets_schema():
    row = get_db().execute("PRAGMA table_info(comment_anchors)").fetchall()
    cols = {r['name'] for r in row}
    assert 'start_offset' in cols
    assert 'end_offset' in cols
    assert 'selected_text' in cols
    print("PASS: comment_anchor_offsets_schema")


def test_document_asset_upload_and_access():
    Config.REPO_ROOT = tempfile.mkdtemp(prefix='md_review_repo_')
    Config.SESSION_FILE_DIR = tempfile.mkdtemp(prefix='md_review_session_')
    client = create_app().test_client()
    conn = get_db()
    owner_id = ensure_user(f'owner-{uuid.uuid4().hex[:8]}')
    viewer_id = ensure_user(f'viewer-{uuid.uuid4().hex[:8]}')
    outsider_id = ensure_user(f'outsider-{uuid.uuid4().hex[:8]}')

    with client.session_transaction() as sess:
        sess['user_id'] = owner_id
    response = client.post('/api/documents', json={'title': 'Asset Doc', 'markdown': 'Hello'})
    assert response.status_code == 201
    document = response.get_json()
    doc_id = document['id']

    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO document_shares (document_id, user_id, role, shared_by, created_at) VALUES (?, ?, ?, ?, ?)",
        (doc_id, viewer_id, 'viewer', owner_id, now)
    )
    conn.commit()

    upload_response = client.post(
        f'/api/documents/{doc_id}/assets',
        data={'file': (io.BytesIO(b'<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>'), 'diagram.svg')},
        content_type='multipart/form-data'
    )
    assert upload_response.status_code == 201
    uploaded = upload_response.get_json()
    assert uploaded['filename'] == 'diagram.svg'
    assert uploaded['url'] == f'/api/documents/{doc_id}/assets/diagram.svg'

    duplicate_response = client.post(
        f'/api/documents/{doc_id}/assets',
        data={'file': (io.BytesIO(b'<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>'), 'diagram.svg')},
        content_type='multipart/form-data'
    )
    assert duplicate_response.status_code == 201
    assert duplicate_response.get_json()['filename'] == 'diagram-1.svg'

    asset_dir = os.path.join(Config.REPO_ROOT, '.md-review', 'assets', doc_id)
    assert os.path.exists(os.path.join(asset_dir, 'diagram.svg'))
    assert os.path.exists(os.path.join(asset_dir, 'diagram-1.svg'))

    with client.session_transaction() as sess:
        sess['user_id'] = viewer_id
    get_response = client.get(uploaded['url'])
    assert get_response.status_code == 200
    assert get_response.mimetype == 'image/svg+xml'

    with client.session_transaction() as sess:
        sess['user_id'] = outsider_id
    denied_response = client.get(uploaded['url'])
    assert denied_response.status_code == 404

    with client.session_transaction() as sess:
        sess['user_id'] = owner_id
    reject_response = client.post(
        f'/api/documents/{doc_id}/assets',
        data={'file': (io.BytesIO(b'not an image'), 'notes.txt')},
        content_type='multipart/form-data'
    )
    assert reject_response.status_code == 400
    print("PASS: document_asset_upload_and_access")

def main():
    tests = [test_init_db, test_ensure_user, test_doc_crud, test_doc_overwrite,
             test_signed_login_token, test_cli_token_emits_valid_token,
             test_cli_token_rejects_other_user_without_root,
             test_diff_add_change_del, test_diff_empty_base, test_diff_word_segments,
             test_diff_punctuation_segments, test_diff_whitespace_segments,
             test_diff_surplus_lines, test_md_headings,
             test_md_list, test_md_code, test_md_inline_math, test_md_table,
             test_comment_anchor_offsets_schema, test_document_asset_upload_and_access]
    ok = 0; fail = 0
    with app.app_context():
        for t in tests:
            try:
                t(); ok += 1
            except AssertionError as e:
                print(f"FAIL: {t.__name__}: {e}"); fail += 1
            except Exception as e:
                print(f"ERROR: {t.__name__}: {type(e).__name__}: {e}"); fail += 1
    print(f"\n{ok} passed, {fail} failed")
    return fail

if __name__ == '__main__':
    sys.exit(main())
