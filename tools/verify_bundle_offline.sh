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
for f in install.sh requirements.txt LICENSE README.md README-docker.md \
         deploy/ping-app.service deploy/env.example \
         src/netping/app.py static/index.html; do
  [[ -f "$DIR/$f" ]] || { echo "MISSING: $f"; exit 1; }
done
echo "[verify] required files present"

# 2. wheels look sane
WHEEL_COUNT=$(ls "$DIR/wheels"/*.whl 2>/dev/null | wc -l | tr -d ' ')
[[ "$WHEEL_COUNT" -gt 5 ]] || { echo "FAIL: only $WHEEL_COUNT wheels"; exit 1; }
echo "[verify] $WHEEL_COUNT wheels"

# 2a. every pinned package has a wheel (names normalized per PEP 503/427:
# lowercase, runs of -_. collapse to _)
normalize() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[-_.]+/_/g'; }

WHEEL_NAMES=""
for w in "$DIR/wheels"/*.whl; do
  WHEEL_NAMES+="$(normalize "$(basename "$w" | cut -d- -f1)")"$'\n'
done

MISSING=""
while IFS= read -r pkg; do
  [[ -n "$pkg" ]] || continue
  grep -qx "$(normalize "$pkg")" <<<"$WHEEL_NAMES" || MISSING+="  $pkg"$'\n'
done < <(grep -oE '^[A-Za-z0-9][A-Za-z0-9._-]*(\[[^]]+\])?==' "$DIR/requirements.txt" \
         | sed -E 's/(\[[^]]+\])?==$//')
if [[ -n "$MISSING" ]]; then
  echo "FAIL: pinned packages without a wheel in wheels/:"
  printf '%s' "$MISSING"
  exit 1
fi
echo "[verify] every pinned requirement has a wheel"

# 2b. version-sentinel cross-check: compute the bundle's target Python the
# SAME way install.sh does — extract every cp3<minor> wheel tag and take the
# numeric MAX. Rationale: non-abi3 wheels always carry the exact build-target
# tag; abi3 wheels (e.g. cp310-abi3-...) carry a lower-or-equal tag and
# install fine on newer Pythons — so the highest tag is the true target.
# Guards against regressions of the cp311→"3.111" sed bug.
# KEEP IN SYNC: install.sh duplicates this exact pipeline.
SENTINEL_MINOR=$(ls "$DIR/wheels"/*.whl 2>/dev/null \
  | grep -oE 'cp3[0-9]+' | sed -E 's/^cp3//' | sort -un | tail -1 || true)
SENTINEL=""
if [[ -n "$SENTINEL_MINOR" ]]; then
  SENTINEL="3.${SENTINEL_MINOR}"
fi
if [[ -n "$SENTINEL" ]]; then
  [[ "$SENTINEL" =~ ^3\.[0-9]+$ ]] \
    || { echo "FAIL: wheel-tag→version transform produced '$SENTINEL' (expected 3.<minor>)"; exit 1; }
  echo "[verify] wheel sentinel Python: $SENTINEL"
else
  echo "[verify] all-pure wheel bundle (no cp tag)"
fi

# 2c. optional resolver proof: when this host matches the bundle target
# (Linux + same Python minor), let pip resolve fully offline without installing.
HOST_PY=$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null || true)
if [[ "$(uname -s)" == "Linux" && -n "$HOST_PY" && ( -z "$SENTINEL" || "$HOST_PY" == "$SENTINEL" ) ]] \
   && python3 -m pip install --dry-run --help >/dev/null 2>&1; then
  echo "[verify] pip dry-run resolve (offline)..."
  python3 -m pip install --dry-run --no-index --find-links "$DIR/wheels" \
    -r "$DIR/requirements.txt" >/dev/null \
    || { echo "FAIL: offline pip resolution failed"; exit 1; }
  echo "[verify] pip can resolve the full set from wheels/ offline"
else
  echo "[verify] skipping pip dry-run (host is not the bundle target platform)"
fi

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
        | grep -v 'LICENSE' || true)
if [[ -n "$LEAKS" ]]; then
  echo "FAIL: CDN/external URLs in static/ — air-gap leak"
  echo "$LEAKS"
  exit 1
fi
echo "[verify] no CDN references in static/"

echo
echo "[verify] bundle structurally sound. NEXT: prove offline install in an isolated Linux VM."
