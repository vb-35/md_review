#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="${PID_FILE:-$ROOT_DIR/data/md_review.pid}"

if [[ ! -f "$PID_FILE" ]]; then
  echo "md_review is not running"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Stopped md_review (PID $PID)"
else
  echo "Stale PID file removed"
fi

rm -f "$PID_FILE"
