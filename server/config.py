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
