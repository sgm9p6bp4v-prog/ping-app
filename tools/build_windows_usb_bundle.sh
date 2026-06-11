#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
DIST="$ROOT/dist"
NAME="ping-me-windows-usb"
STAGE="$DIST/$NAME-$STAMP/$NAME"
ZIP="$DIST/$NAME-$STAMP.zip"
PYTHON="${PING_PYTHON:-$ROOT/.venv/bin/python}"

mkdir -p "$STAGE" "$STAGE/wheelhouse"

mkdir -p "$STAGE/src" "$STAGE/static" "$STAGE/scripts"

rsync -a --exclude "__pycache__/" --exclude "*.pyc" "$ROOT/src/" "$STAGE/src/"
rsync -a "$ROOT/static/" "$STAGE/static/"
rsync -a "$ROOT/scripts/"*.ps1 "$STAGE/scripts/"

cp "$ROOT/LICENSE" "$STAGE/"
cp "$ROOT/README.md" "$STAGE/"
cp "$ROOT/README-native.md" "$STAGE/"
cp "$ROOT/README-windows-usb.md" "$STAGE/"
cp "$ROOT/requirements-windows.txt" "$STAGE/"
cp "$ROOT/pyproject.toml" "$STAGE/"

if [ "${PING_SKIP_WINDOWS_WHEELS:-0}" != "1" ]; then
  "$PYTHON" -m pip download \
    --dest "$STAGE/wheelhouse" \
    --only-binary=:all: \
    --platform win_amd64 \
    --implementation cp \
    --python-version 312 \
    --abi cp312 \
    -r "$ROOT/requirements-windows.txt"
fi

(
  cd "$(dirname "$STAGE")"
  zip -rq "$ZIP" "$NAME"
)

echo "$ZIP"
