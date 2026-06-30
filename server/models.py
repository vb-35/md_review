import sqlite3
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

    CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_path TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lock_owner_id TEXT,
        locked_at TEXT,
        FOREIGN KEY (owner_id) REFERENCES users(id),
        FOREIGN KEY (updated_by) REFERENCES users(id),
        FOREIGN KEY (lock_owner_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS file_versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        diff TEXT,
        message TEXT DEFAULT '',
        author_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (author_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS project_shares (
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        shared_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (shared_by) REFERENCES users(id)
    );
    """)
    return conn


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


def get_user_by_username(username):
    row = get_db().execute(
        "SELECT id, username, created_at FROM users WHERE username = ?",
        (username,)
    ).fetchone()
    return row_to_dict(row)


def get_user_by_id(user_id):
    row = get_db().execute(
        "SELECT id, username, created_at FROM users WHERE id = ?",
        (user_id,)
    ).fetchone()
    return row_to_dict(row)


def get_project_for_user(project_id, user_id):
    project_row = get_db().execute(
        "SELECT p.*, "
        "owner.username AS owner_username, "
        "updater.username AS updated_by_username, "
        "locker.username AS lock_owner_username "
        "FROM projects p "
        "JOIN users owner ON owner.id = p.owner_id "
        "LEFT JOIN users updater ON updater.id = p.updated_by "
        "LEFT JOIN users locker ON locker.id = p.lock_owner_id "
        "WHERE p.id = ?",
        (project_id,)
    ).fetchone()
    if not project_row:
        return None

    project = dict(project_row)
    if project['owner_id'] == user_id:
        project['access_role'] = 'owner'
        project['is_owner'] = 1
        project['shared_by_username'] = None
        return project

    share_row = get_db().execute(
        "SELECT ps.role, ps.shared_by, sharer.username AS shared_by_username "
        "FROM project_shares ps "
        "JOIN users sharer ON sharer.id = ps.shared_by "
        "WHERE ps.project_id = ? AND ps.user_id = ?",
        (project_id, user_id)
    ).fetchone()
    if not share_row:
        return None

    project['access_role'] = share_row['role']
    project['is_owner'] = 0
    project['shared_by'] = share_row['shared_by']
    project['shared_by_username'] = share_row['shared_by_username']
    return project


def user_can_edit_project(project_id, user_id):
    row = get_project_for_user(project_id, user_id)
    return row is not None and row['access_role'] in ('owner', 'editor')


def row_to_dict(row):
    if row is None:
        return None
    return dict(row)
