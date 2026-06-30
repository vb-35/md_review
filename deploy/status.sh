#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="${PID_FILE:-$ROOT_DIR/data/md_review.pid}"
LOG_FILE="${LOG_FILE:-$ROOT_DIR/data/server.log}"
PORT="${PORT:-18080}"

if [[ ! -f "$PID_FILE" ]]; then
  echo "md_review is not running"
  exit 1
fi

PID="$(cat "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "md_review pid file exists but process is not running"
  exit 1
fi

echo "md_review is running"
echo "PID: $PID"
echo "Port: $PORT"
echo "Log: $LOG_FILE"

if command -v ss >/dev/null 2>&1; then
  ss -ltnp | grep ":${PORT} " || true
fi
