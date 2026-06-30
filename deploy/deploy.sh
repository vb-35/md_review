#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="${VENV_DIR:-$ROOT_DIR/.venv}"
PID_FILE="${PID_FILE:-$ROOT_DIR/data/md_review.pid}"
LOG_FILE="${LOG_FILE:-$ROOT_DIR/data/server.log}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-18080}"
WORKERS="${WORKERS:-2}"
THREADS="${THREADS:-4}"
APP_BASE_PATH="${APP_BASE_PATH:-}"
SECRET_FILE="${SECRET_FILE:-$ROOT_DIR/data/secret_key}"
DATABASE_PATH="${DATABASE_PATH:-$ROOT_DIR/data/md_review.db}"
SESSION_FILE_DIR="${SESSION_FILE_DIR:-$ROOT_DIR/data/flask_session}"
LOCAL_AUTH="${LOCAL_AUTH:-off}"
PAM_SERVICE="${PAM_SERVICE:-login}"

mkdir -p "$ROOT_DIR/data" "$SESSION_FILE_DIR"

if [[ -z "${SECRET_KEY:-}" ]]; then
  if [[ ! -f "$SECRET_FILE" ]]; then
    python3 -c "import secrets; print(secrets.token_urlsafe(48))" >"$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
  fi
  SECRET_KEY="$(cat "$SECRET_FILE")"
fi

if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR"
fi

"$VENV_DIR/bin/pip" install --upgrade pip >/dev/null
"$VENV_DIR/bin/pip" install -r "$ROOT_DIR/server/requirements.txt"

if ss -ltn "( sport = :${PORT} )" | tail -n +2 | grep -q .; then
  echo "Port ${PORT} is already in use. Pick another one with PORT=..."
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${OLD_PID:-}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "md_review is already running with PID $OLD_PID"
    echo "SSH tunnel: ssh -L ${PORT}:127.0.0.1:${PORT} $(whoami)@$(hostname -f 2>/dev/null || hostname)"
    echo "Browser: http://127.0.0.1:${PORT}/"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

cd "$ROOT_DIR/server"
export SECRET_KEY DATABASE_PATH SESSION_FILE_DIR LOCAL_AUTH PAM_SERVICE APP_BASE_PATH

"$VENV_DIR/bin/gunicorn" \
  --chdir "$ROOT_DIR/server" \
  --bind "${HOST}:${PORT}" \
  --workers "$WORKERS" \
  --threads "$THREADS" \
  --pid "$PID_FILE" \
  --access-logfile "$LOG_FILE" \
  --error-logfile "$LOG_FILE" \
  --capture-output \
  --daemon \
  "run:create_app()"

sleep 2

if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Failed to start md_review. Check $LOG_FILE"
  exit 1
fi

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -z "${SERVER_IP:-}" ]]; then
  SERVER_IP="127.0.0.1"
fi

URL_PATH="/"
if [[ -n "$APP_BASE_PATH" ]]; then
  URL_PATH="${APP_BASE_PATH%/}/"
fi

echo "md_review is running with PID $(cat "$PID_FILE")"
echo "Web app: http://${SERVER_IP}:${PORT}${URL_PATH}"
echo "SSH tunnel: ssh -L ${PORT}:127.0.0.1:${PORT} $(whoami)@$(hostname -f 2>/dev/null || hostname)"
echo "Browser via tunnel: http://127.0.0.1:${PORT}${URL_PATH}"
echo "Logs: $LOG_FILE"
