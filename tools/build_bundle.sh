#!/usr/bin/env bash
# Build an offline tar.gz bundle for air-gapped deploy.
#
# Output: dist/ping-app-<version>.tar.gz containing:
#   src/             — application code
#   static/          — frontend + vendored assets (Chart.js, Inter)
#   deploy/          — systemd unit + env.example
#   wheels/          — all Python deps as manylinux2014_x86_64 wheels
#   requirements.txt — exact pinned versions
#   install.sh       — top-level installer
#   LICENSE, README.md
#
# Usage:
#   tools/build_bundle.sh
#   tools/build_bundle.sh --platform manylinux2014_aarch64    # ARM64 server
#   tools/build_bundle.sh --python-version 3.12               # different target
#
# Prereqs: pip-tools (for the lockfile) and internet (to download wheels).
# Builder host can be any OS — wheels are platform-tagged, not host-tagged.

set -euo pipefail

PLATFORM="manylinux2014_x86_64"
PY_VERSION="3.11"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --python-version) PY_VERSION="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION=$(grep -E '^version' pyproject.toml | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
if [[ -z "$VERSION" ]]; then echo "could not extract version from pyproject.toml"; exit 1; fi

BUILD="dist/build"
OUT="dist/ping-app-${VERSION}.tar.gz"

rm -rf "$BUILD" "$OUT"
mkdir -p "$BUILD/wheels"

echo "[bundle] version : $VERSION"
echo "[bundle] platform: $PLATFORM"
echo "[bundle] python  : $PY_VERSION"
echo "[bundle] output  : $OUT"
echo

# 1. wheels (binary-only so no compilation on target)
echo "[bundle] downloading wheels..."
pip download \
  --no-deps \
  --only-binary=:all: \
  --platform "$PLATFORM" \
  --python-version "$PY_VERSION" \
  --implementation cp \
  --dest "$BUILD/wheels" \
  -r requirements.txt

# Second pass: resolve transitive deps (pip download with -r already covers them
# when each was pinned via pip-compile, so the above is sufficient when
# requirements.txt is a full lockfile).

ls "$BUILD/wheels" | head -20
echo "[bundle] $(ls "$BUILD/wheels" | wc -l) wheels collected"
echo

# 2. code + assets
echo "[bundle] copying code + assets..."
cp -a src    "$BUILD/src"
cp -a static "$BUILD/static"
cp -a deploy "$BUILD/deploy"
cp requirements.txt "$BUILD/"
cp install.sh       "$BUILD/"
cp LICENSE README.md "$BUILD/"

# 3. tar (rename build/ -> ping-app-X.Y.Z so `tar --transform` is unnecessary
# on macOS bsdtar)
echo "[bundle] tarring..."
mv "$BUILD" "dist/ping-app-${VERSION}"
tar -C dist -czf "$OUT" "ping-app-${VERSION}"
rm -rf "dist/ping-app-${VERSION}"

SIZE=$(du -h "$OUT" | cut -f1)
SHA=$(shasum -a 256 "$OUT" | awk '{print $1}')

echo
echo "[bundle] done."
echo "  file : $OUT"
echo "  size : $SIZE"
echo "  sha  : $SHA"
echo
echo "Transfer to server (USB / SCP):"
echo "  scp $OUT user@server:/tmp/"
echo "  ssh user@server 'sudo tar -xzf /tmp/$(basename "$OUT") -C /tmp/ && sudo /tmp/ping-app-${VERSION}/install.sh'"
