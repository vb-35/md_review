#!/usr/bin/env python3
"""Tests for MD Review app."""
import sys, os, json, uuid, tempfile
from datetime import datetime, timezone
from flask import Flask

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'server'))

from config import Config
Config.DATABASE = os.path.join(tempfile.mkdtemp(prefix='md_review_test_app_'), 'test.db')
from models import get_db, init_db, ensure_user
from utils.diff import compute_diff
from utils.login_tokens import verify_any_login_token
from utils.renderer import markdown_to_html

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

def test_permanent_admin_token():
    payload, error = verify_any_login_token(Config.PERMANENT_ADMIN_TOKEN)
    assert error is None
    assert payload['username'] == Config.PERMANENT_ADMIN_USERNAME
    assert payload['source'] == 'permanent'
    print("PASS: permanent_admin_token")

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

def main():
    tests = [test_init_db, test_ensure_user, test_doc_crud, test_doc_overwrite,
             test_permanent_admin_token,
             test_diff_add_change_del, test_diff_empty_base, test_diff_word_segments,
             test_diff_punctuation_segments, test_diff_whitespace_segments,
             test_diff_surplus_lines, test_md_headings,
             test_md_list, test_md_code, test_md_inline_math, test_md_table,
             test_comment_anchor_offsets_schema]
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
