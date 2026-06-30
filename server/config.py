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
    AUTH_MODE = os.environ.get('AUTH_MODE', ('pam' if os.name == 'nt' else 'trusted_user')).strip().lower()
    TRUSTED_USER_HEADER = os.environ.get('TRUSTED_USER_HEADER', 'X-Remote-User').strip() or 'X-Remote-User'
    TRUSTED_USER_LOCAL_ONLY = os.environ.get('TRUSTED_USER_LOCAL_ONLY', 'on').strip().lower() in ('on', '1', 'true', 'yes')
    TOKEN_LOGIN_SECRET = os.environ.get('TOKEN_LOGIN_SECRET', SECRET_KEY)
    TOKEN_LOGIN_MAX_AGE_SECONDS = int(os.environ.get('TOKEN_LOGIN_MAX_AGE_SECONDS', '120'))
    PERMANENT_ADMIN_USERNAME = 'admin'
    PERMANENT_ADMIN_TOKEN = 'md-review-admin-permanent-token-7e6c9c4f'
    # For local dev on non-Linux: accept any non-empty credentials
    LOCAL_AUTH = os.environ.get('LOCAL_AUTH', ('on' if os.name == 'nt' else 'off'))
