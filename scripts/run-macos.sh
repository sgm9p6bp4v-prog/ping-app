#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${PING_VENV_PATH:-$ROOT/.venv}"
PYTHON="${PING_PYTHON:-python3}"
DATA_DIR="${PING_DATA_DIR:-$HOME/Library/Application Support/ping.me}"
DB_PATH="${PING_DB_PATH:-$DATA_DIR/ping.db}"
BIND_HOST="${PING_BIND_HOST:-0.0.0.0}"
PORT="${PING_PORT:-8000}"
REQ="$ROOT/requirements.txt"
MARKER="$VENV/.pingme-requirements-installed"

mkdir -p "$DATA_DIR"

if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON" -m venv "$VENV"
fi

if [ ! -f "$MARKER" ] || [ "$REQ" -nt "$MARKER" ]; then
  "$VENV/bin/python" -m pip install -r "$REQ"
  touch "$MARKER"
fi

export PYTHONPATH="$ROOT/src"
export PING_BIND_HOST="$BIND_HOST"
export PING_PORT="$PORT"
export PING_DB_PATH="$DB_PATH"

echo "ping.me native macOS server"
echo "URL: http://$BIND_HOST:$PORT/"
echo "Database: $PING_DB_PATH"

exec "$VENV/bin/python" -m uvicorn netping.app:app \
  --app-dir "$ROOT/src" \
  --host "$BIND_HOST" \
  --port "$PORT"
