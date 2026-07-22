import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
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
        commit_sha TEXT,
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

    CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
    );
    """)
    apply_migrations(conn)
    return conn


def _column_exists(conn, table_name, column_name):
    return any(row['name'] == column_name for row in conn.execute(f'PRAGMA table_info({table_name})'))


def apply_migrations(conn):
    applied = {row['version'] for row in conn.execute('SELECT version FROM schema_migrations')}
    if 1 not in applied:
        if not _column_exists(conn, 'projects', 'lock_expires_at'):
            conn.execute('ALTER TABLE projects ADD COLUMN lock_expires_at TEXT')
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS revision_proposals (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            author_id TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL DEFAULT '',
            base_commit_sha TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            stale_reason TEXT,
            created_at TEXT NOT NULL,
            decided_by TEXT,
            decided_at TEXT,
            applied_commit_sha TEXT,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (author_id) REFERENCES users(id),
            FOREIGN KEY (decided_by) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS revision_proposal_files (
            proposal_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            base_content TEXT NOT NULL,
            proposed_content TEXT NOT NULL,
            PRIMARY KEY (proposal_id, file_path),
            FOREIGN KEY (proposal_id) REFERENCES revision_proposals(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS revision_proposal_comment_actions (
            id TEXT PRIMARY KEY,
            proposal_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            source_commit_sha TEXT NOT NULL,
            source_fingerprint TEXT NOT NULL,
            action_type TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (proposal_id) REFERENCES revision_proposals(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS revision_proposal_decisions (
            proposal_id TEXT NOT NULL,
            item_kind TEXT NOT NULL,
            file_path TEXT NOT NULL DEFAULT '',
            item_id TEXT NOT NULL,
            decision TEXT NOT NULL,
            reviewer_id TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (proposal_id, item_kind, file_path, item_id),
            FOREIGN KEY (proposal_id) REFERENCES revision_proposals(id) ON DELETE CASCADE,
            FOREIGN KEY (reviewer_id) REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_revision_proposals_project_status
            ON revision_proposals(project_id, status, created_at);
        """)
        conn.execute(
            'UPDATE projects SET lock_owner_id = NULL, locked_at = NULL, lock_expires_at = NULL'
        )
        conn.execute(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
            (1, datetime.now(timezone.utc).isoformat())
        )
        conn.commit()

    if 2 not in applied:
        proposal_file_columns = (
            ('applied_decisions_hash', 'TEXT'),
            ('applied_commit_sha', 'TEXT'),
            ('applied_at', 'TEXT'),
        )
        for column_name, column_type in proposal_file_columns:
            if not _column_exists(conn, 'revision_proposal_files', column_name):
                conn.execute(
                    f'ALTER TABLE revision_proposal_files ADD COLUMN {column_name} {column_type}'
                )
        conn.execute(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
            (2, datetime.now(timezone.utc).isoformat())
        )
        conn.commit()

    if 3 not in applied:
        if not _column_exists(conn, 'file_versions', 'commit_sha'):
            conn.execute('ALTER TABLE file_versions ADD COLUMN commit_sha TEXT')
        conn.execute(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
            (3, datetime.now(timezone.utc).isoformat())
        )
        conn.commit()


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
    if project_lock_is_expired(project):
        project['lock_owner_id'] = None
        project['lock_owner_username'] = None
        project['locked_at'] = None
        project['lock_expires_at'] = None
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
    return row is not None and row['access_role'] in ('owner', 'admin', 'editor')


def parse_timestamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def project_lock_is_expired(project, now=None):
    if not project or not project.get('lock_owner_id'):
        return False
    expires_at = parse_timestamp(project.get('lock_expires_at'))
    if expires_at is None:
        return True
    return expires_at <= (now or datetime.now(timezone.utc))


def acquire_project_lock(project_id, user_id, ttl_seconds=None):
    from config import Config

    ttl = int(ttl_seconds or Config.PROJECT_LOCK_TTL_SECONDS)
    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
    expires_at = (now_dt + timedelta(seconds=ttl)).isoformat()
    conn = get_db()
    conn.execute('BEGIN IMMEDIATE')
    row = conn.execute(
        'SELECT lock_owner_id, locked_at, lock_expires_at FROM projects WHERE id = ?',
        (project_id,)
    ).fetchone()
    if not row:
        conn.rollback()
        return None, 'not_found'
    current = dict(row)
    if current['lock_owner_id'] not in (None, user_id) and not project_lock_is_expired(current, now_dt):
        conn.rollback()
        return current, 'locked'
    conn.execute(
        'UPDATE projects SET lock_owner_id = ?, locked_at = ?, lock_expires_at = ? WHERE id = ?',
        (user_id, now, expires_at, project_id)
    )
    conn.commit()
    return {
        'lock_owner_id': user_id,
        'locked_at': now,
        'lock_expires_at': expires_at,
    }, None


def refresh_project_lock(project_id, user_id, ttl_seconds=None):
    return acquire_project_lock(project_id, user_id, ttl_seconds)


def release_project_lock(project_id, user_id):
    conn = get_db()
    cursor = conn.execute(
        'UPDATE projects SET lock_owner_id = NULL, locked_at = NULL, lock_expires_at = NULL '
        'WHERE id = ? AND lock_owner_id = ?',
        (project_id, user_id)
    )
    conn.commit()
    return cursor.rowcount == 1


def row_to_dict(row):
    if row is None:
        return None
    return dict(row)
