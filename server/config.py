import os
import sys

class Config:
    APP_BASE_PATH = os.environ.get('APP_BASE_PATH', '').strip()
    SECRET_KEY = os.environ.get('SECRET_KEY', 'local-dev-key')
    SESSION_TYPE = 'filesystem'
    SESSION_FILE_DIR = os.environ.get('SESSION_FILE_DIR', os.path.abspath('flask_session'))
    SESSION_COOKIE_HTTPONLY = True
    DATABASE = os.environ.get('DATABASE_PATH', 'md_review.db')
    PAM_SERVICE = os.environ.get('PAM_SERVICE', 'login')
    # For local dev on non-Linux: accept any non-empty credentials
    LOCAL_AUTH = os.environ.get('LOCAL_AUTH', ('on' if os.name == 'nt' else 'off'))
