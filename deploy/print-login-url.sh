#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="${VENV_DIR:-$ROOT_DIR/.venv}"
SECRET_FILE="${SECRET_FILE:-$ROOT_DIR/data/secret_key}"
APP_BASE_PATH="${APP_BASE_PATH:-}"
PORT="${PORT:-18080}"
LOGIN_HOST="${LOGIN_HOST:-127.0.0.1}"
USERNAME="${LOGIN_USERNAME:-$(whoami)}"

if [[ -z "${TOKEN_LOGIN_SECRET:-}" ]]; then
  if [[ ! -f "$SECRET_FILE" ]]; then
    echo "Missing secret file: $SECRET_FILE" >&2
    exit 1
  fi
  TOKEN_LOGIN_SECRET="$(cat "$SECRET_FILE")"
fi

if [[ -n "$APP_BASE_PATH" ]]; then
  BASE_PATH="${APP_BASE_PATH%/}/"
else
  BASE_PATH="/"
fi

TOKEN="$(
  LOGIN_USERNAME="$USERNAME" \
  TOKEN_LOGIN_SECRET="$TOKEN_LOGIN_SECRET" \
  TOKEN_LOGIN_MAX_AGE_SECONDS="${TOKEN_LOGIN_MAX_AGE_SECONDS:-120}" \
  PYTHONPATH="$ROOT_DIR/server" \
  "$VENV_DIR/bin/python" - <<'PY'
import os
from utils.login_tokens import issue_login_token

username = os.environ['LOGIN_USERNAME'] if 'LOGIN_USERNAME' in os.environ else None
if not username:
    raise SystemExit('LOGIN_USERNAME missing')
print(issue_login_token(username))
PY
)"

printf 'Open this URL in the browser that is using your SSH tunnel:\n'
printf 'http://%s:%s%s?token=%s\n' "$LOGIN_HOST" "$PORT" "$BASE_PATH" "$TOKEN"
