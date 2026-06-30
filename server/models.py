import sqlite3
import json
import uuid
from datetime import datetime, timezone
from flask import g

_db_instance = None

def get_db_path():
    global _db_instance
    if _db_instance is None:
        from config import Config
        _db_instance = Config.DATABASE
    return _db_instance

def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(get_db_path(), check_same_thread=False)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db

import atexit
def close_db(e=None):
    db = g.pop('db', None)
    if db is not None:
        db.close()

def init_db():
    conn = sqlite3.connect(get_db_path(), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        markdown TEXT NOT NULL DEFAULT '',
        html_cache TEXT,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lock_owner_id TEXT,
        locked_at TEXT,
        FOREIGN KEY (lock_owner_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS change_sets (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        base_markdown TEXT NOT NULL,
        candidate_markdown TEXT NOT NULL,
        diff TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_by TEXT,
        reviewed_at TEXT,
        FOREIGN KEY (document_id) REFERENCES documents(id),
        FOREIGN KEY (created_by) REFERENCES users(id),
        FOREIGN KEY (reviewed_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS document_versions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        markdown TEXT NOT NULL,
        diff TEXT,
        message TEXT DEFAULT '',
        author_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (author_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS comment_threads (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        change_set_id TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id),
        FOREIGN KEY (change_set_id) REFERENCES change_sets(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES comment_threads(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS comment_anchors (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        start_offset INTEGER,
        end_offset INTEGER,
        FOREIGN KEY (thread_id) REFERENCES comment_threads(id) ON DELETE CASCADE
    );
    """)
    # Migrations
    try:
        conn.execute("ALTER TABLE comment_threads ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE comment_threads ADD COLUMN resolved_by TEXT")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE comment_threads ADD COLUMN resolved_at TEXT")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE comment_anchors ADD COLUMN selected_text TEXT")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    conn.close()

def ensure_user(username):
    conn = get_db()
    existing = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    if existing:
        return existing['id']
    uid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)", (uid, username, now))
    conn.commit()
    return uid

def row_to_dict(row):
    if row is None:
        return None
    return dict(row)
