from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from config import Config

TOKEN_SALT = 'md-review-login'


def _serializer():
    return URLSafeTimedSerializer(Config.TOKEN_LOGIN_SECRET, salt=TOKEN_SALT)


def issue_login_token(username):
    return _serializer().dumps({
        'username': username,
        'purpose': 'login'
    })


def verify_login_token(token):
    try:
        payload = _serializer().loads(token, max_age=Config.TOKEN_LOGIN_MAX_AGE_SECONDS)
    except SignatureExpired:
        return None, 'Login token expired'
    except BadSignature:
        return None, 'Invalid login token'

    if payload.get('purpose') != 'login':
        return None, 'Invalid login token'

    username = payload.get('username')
    if not username:
        return None, 'Invalid login token'

    return {
        'username': username,
        'source': 'signed'
    }, None
