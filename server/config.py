import os
import secrets

class Config:
    APP_BASE_PATH = os.environ.get('APP_BASE_PATH', '').strip()
    SECRET_KEY = os.environ.get('SECRET_KEY') or secrets.token_urlsafe(48)
    SESSION_TYPE = 'filesystem'
    SESSION_FILE_DIR = os.environ.get('SESSION_FILE_DIR', os.path.abspath('flask_session'))
    SESSION_COOKIE_HTTPONLY = True
    DATABASE = os.environ.get('DATABASE_PATH', 'md_review.db')
    REPO_ROOT = os.environ.get('REPO_ROOT', '').strip()
    PROJECTS_DIR = os.environ.get('PROJECTS_DIR', '.md-review/projects').strip() or '.md-review/projects'
    COMMENTS_DIR = os.environ.get('COMMENTS_DIR', '.md-review/comments').strip() or '.md-review/comments'
    PROJECT_LOCK_TTL_SECONDS = int(os.environ.get('PROJECT_LOCK_TTL_SECONDS', '300'))
    GIT_IMPORT_TIMEOUT_SECONDS = int(os.environ.get('GIT_IMPORT_TIMEOUT_SECONDS', '120'))
    ARCHIVE_IMPORT_MAX_UPLOAD_BYTES = int(os.environ.get('ARCHIVE_IMPORT_MAX_UPLOAD_BYTES', str(100 * 1024 * 1024)))
    ARCHIVE_IMPORT_MAX_EXTRACTED_BYTES = int(os.environ.get('ARCHIVE_IMPORT_MAX_EXTRACTED_BYTES', str(500 * 1024 * 1024)))
    ARCHIVE_IMPORT_MAX_FILES = int(os.environ.get('ARCHIVE_IMPORT_MAX_FILES', '10000'))
