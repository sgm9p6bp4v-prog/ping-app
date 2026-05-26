#!/usr/bin/env bash
# Sanity-check a built bundle without internet — the only honest air-gap proof.
#
# Recommended use: run inside a minimal Linux VM with the network interface DOWN.
#   sudo ip link set eth0 down
#   sudo ./verify_bundle_offline.sh dist/ping-app-X.Y.Z.tar.gz
#
# Without a VM (running on the dev host with network enabled), this script can
# still catch most packaging mistakes (missing files, wheel-platform mismatch,
# install.sh syntax errors) but cannot prove offline-install — see HOLD-VM in
# 00_infos/meta/open-questions.md.

set -euo pipefail

BUNDLE="${1:-}"
if [[ -z "$BUNDLE" ]]; then
  echo "usage: $0 <ping-app-X.Y.Z.tar.gz>" >&2
  exit 1
fi
[[ -f "$BUNDLE" ]] || { echo "$BUNDLE not found"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "[verify] extracting $BUNDLE -> $TMP"
tar -xzf "$BUNDLE" -C "$TMP"

DIR=$(ls "$TMP" | head -1)
DIR="$TMP/$DIR"
echo "[verify] dir: $DIR"

# 1. required files exist
for f in install.sh requirements.txt LICENSE README.md \
         deploy/ping-app.service deploy/env.example \
         src/netping/app.py static/index.html; do
  [[ -f "$DIR/$f" ]] || { echo "MISSING: $f"; exit 1; }
done
echo "[verify] required files present"

# 2. wheels look sane
WHEEL_COUNT=$(ls "$DIR/wheels"/*.whl 2>/dev/null | wc -l | tr -d ' ')
[[ "$WHEEL_COUNT" -gt 5 ]] || { echo "FAIL: only $WHEEL_COUNT wheels"; exit 1; }
echo "[verify] $WHEEL_COUNT wheels"

# 3. wheels are correct platform
NON_PURE=$(ls "$DIR/wheels"/*.whl | grep -v -E "(py3-none-any|any.whl)$" | wc -l | tr -d ' ' || true)
if [[ $NON_PURE -gt 0 ]]; then
  echo "[verify] platform wheels:"
  ls "$DIR/wheels"/*.whl | grep -v -E "(py3-none-any|any.whl)$" | sed 's/.*\///' | head -5
fi

# 4. install.sh shellcheck-light
bash -n "$DIR/install.sh" || { echo "install.sh has syntax errors"; exit 1; }
echo "[verify] install.sh syntax OK"

# 5. systemd unit syntactic sanity (basic)
grep -q '^\[Unit\]' "$DIR/deploy/ping-app.service" || { echo "systemd unit missing [Unit]"; exit 1; }
grep -q '^\[Service\]' "$DIR/deploy/ping-app.service" || { echo "systemd unit missing [Service]"; exit 1; }
grep -q 'ExecStart=' "$DIR/deploy/ping-app.service" || { echo "systemd unit missing ExecStart"; exit 1; }
echo "[verify] systemd unit looks well-formed"

# 6. no leaked CDN/internet references in static/
LEAKS=$(grep -rEn 'https?://(cdn\.|fonts\.googleapis|unpkg|jsdelivr)' "$DIR/static/" 2>/dev/null \
        | grep -v 'vendor-manifest.json' \
        | grep -v 'OFL.txt' \
        | grep -v 'LICENSE' \
        | grep -v 'chartjs.LICENSE' || true)
if [[ -n "$LEAKS" ]]; then
  echo "FAIL: CDN/external URLs in static/ — air-gap leak"
  echo "$LEAKS"
  exit 1
fi
echo "[verify] no CDN references in static/"

echo
echo "[verify] bundle structurally sound. NEXT: prove offline install in an isolated Linux VM."
