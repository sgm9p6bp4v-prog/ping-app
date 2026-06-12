#!/usr/bin/env bash
# Build an offline tar.gz bundle for air-gapped deploy.
#
# Output: dist/ping-app-<version>.tar.gz containing:
#   src/             — application code
#   static/          — frontend + vendored assets (Inter)
#   deploy/          — systemd unit + env.example
#   wheels/          — all Python deps as manylinux wheels (2014/2_17/2_28)
#   requirements.txt — exact pinned versions
#   install.sh       — top-level installer
#   LICENSE, README.md + README-*.md
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

if [[ -n "${PIP:-}" ]]; then
  PIP_CMD=("$PIP")
elif [[ -x "$ROOT/.venv/bin/pip" ]]; then
  PIP_CMD=("$ROOT/.venv/bin/pip")
elif command -v pip >/dev/null; then
  PIP_CMD=("pip")
elif python3 -m pip --version >/dev/null 2>&1; then
  PIP_CMD=("python3" "-m" "pip")
else
  echo "pip not found. Run 'make install-dev' or set PIP=/path/to/pip." >&2
  exit 1
fi

BUILD="dist/build"
OUT="dist/ping-app-${VERSION}.tar.gz"

rm -rf "$BUILD" "$OUT"
mkdir -p "$BUILD/wheels"

echo "[bundle] version : $VERSION"
echo "[bundle] platform: $PLATFORM"
echo "[bundle] python  : $PY_VERSION"
echo "[bundle] output  : $OUT"
echo

# requirements.txt is pip-compiled on the BUILDER's Python, while the bundle
# targets --python-version ($PY_VERSION). If a dependency ever gains a
# python_version environment marker, a lockfile compiled under a different
# minor would omit/include the wrong packages and the air-gapped install
# fails. Loud warning, not a hard fail — today's dep tree has no such markers.
BUILDER_PY=$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null || true)
if [[ -n "$BUILDER_PY" && "$BUILDER_PY" != "$PY_VERSION" ]]; then
  echo "WARNING: builder Python is $BUILDER_PY but the bundle targets $PY_VERSION." >&2
  echo "         If any dependency uses python_version environment markers, the"   >&2
  echo "         lockfile is wrong for the target. Recompile requirements.txt"     >&2
  echo "         under Python $PY_VERSION (pip-compile --generate-hashes)."        >&2
fi

# 1. wheels (binary-only so no compilation on target)
# pip accepts repeated --platform flags; offer the whole manylinux ladder for
# the target arch so deps that only ship manylinux_2_28 (or only 2014) wheels
# still resolve. Non-manylinux --platform values are passed through unchanged.
PLATFORM_FLAGS=(--platform "$PLATFORM")
ARCH=$(printf '%s' "$PLATFORM" | sed -E 's/^manylinux(2014|_2_[0-9]+)_//')
if [[ "$ARCH" != "$PLATFORM" ]]; then
  PLATFORM_FLAGS=(
    --platform "manylinux2014_${ARCH}"
    --platform "manylinux_2_17_${ARCH}"
    --platform "manylinux_2_28_${ARCH}"
  )
fi

echo "[bundle] downloading wheels..."
"${PIP_CMD[@]}" download \
  --no-deps \
  --only-binary=:all: \
  "${PLATFORM_FLAGS[@]}" \
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
# Ship the whole README set — README.md cross-links the others.
cp LICENSE README.md README-*.md "$BUILD/"

# Strip dev-machine bytecode caches from the staged copy: cp -a would ship
# __pycache__/*.pyc compiled for the builder's Python version(s).
find "$BUILD/src" "$BUILD/static" -type d -name '__pycache__' -prune -exec rm -rf {} +
find "$BUILD/src" "$BUILD/static" -type f -name '*.pyc' -delete

# 3. tar (rename build/ -> ping-app-X.Y.Z so `tar --transform` is unnecessary
# on macOS bsdtar). With GNU tar we normalize order/mtime/ownership and use
# `gzip -n` so the same inputs always produce a byte-identical bundle; bsdtar
# (macOS builder) lacks --sort/--mtime, so there the bundle is functional but
# not byte-reproducible across builds.
echo "[bundle] tarring..."
mv "$BUILD" "dist/ping-app-${VERSION}"
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner \
    -C dist -cf - "ping-app-${VERSION}" | gzip -n > "$OUT"
else
  tar -C dist -czf "$OUT" "ping-app-${VERSION}"
fi
rm -rf "dist/ping-app-${VERSION}"

SIZE=$(du -h "$OUT" | cut -f1)
SHA=$( (sha256sum "$OUT" 2>/dev/null || shasum -a 256 "$OUT") | awk '{print $1}')

echo
echo "[bundle] done."
echo "  file : $OUT"
echo "  size : $SIZE"
echo "  sha  : $SHA"
echo
echo "Transfer to server (USB / SCP):"
echo "  scp $OUT user@server:/tmp/"
echo "  ssh user@server 'sudo tar -xzf /tmp/$(basename "$OUT") -C /tmp/ && sudo /tmp/ping-app-${VERSION}/install.sh'"
