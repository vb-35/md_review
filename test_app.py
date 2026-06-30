#!/usr/bin/env python3
"""Tests for MD Review app."""
import io
import importlib.util
import os
import sys
import tempfile
import uuid
from contextlib import redirect_stdout
from importlib.machinery import SourceFileLoader

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'server'))

from config import Config
Config.DATABASE = os.path.join(tempfile.mkdtemp(prefix='md_review_test_app_'), 'test.db')
Config.REPO_ROOT = tempfile.mkdtemp(prefix='md_review_storage_')
Config.SESSION_FILE_DIR = tempfile.mkdtemp(prefix='md_review_session_')
from models import get_db, init_db, ensure_user
from run import create_app
from utils.diff import compute_diff
from utils.login_tokens import issue_login_token, verify_login_token
from utils.renderer import markdown_to_html

CTL_PATH = os.path.join(os.path.dirname(__file__), 'md-reviewctl')
CTL_SPEC = importlib.util.spec_from_loader('md_reviewctl', SourceFileLoader('md_reviewctl', CTL_PATH))
md_reviewctl = importlib.util.module_from_spec(CTL_SPEC)
CTL_SPEC.loader.exec_module(md_reviewctl)

APP = create_app()


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
    test_signed_login_token()
    test_cli_token_emits_valid_token()
    test_diff_and_renderer()
    print("ALL PASS")
