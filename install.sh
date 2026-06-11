#!/usr/bin/env bash
# NetPing Dashboard — air-gapped installer.
#
# Run on the target Linux server as root from inside the unpacked bundle
# directory (the one containing this script). Idempotent: re-running upgrades
# in place without touching /var/lib/ping-app data.
#
# Tested matrix: Debian 12 / Ubuntu 24.04. Python 3.11+.
# Ubuntu 22.04 ships Python 3.10 — usable only with a separately provisioned
# Python 3.11+ (e.g. deadsnakes or a vendor build) passed via PYTHON=...

set -euo pipefail

# Hardened hosts often run root with umask 027/077 — files created below would
# then be unreadable by the ping-app service user (venv/src group/other access
# stripped → systemd 203/EXEC crash loop). Force a world-readable umask.
umask 022

APP_USER=${APP_USER:-ping-app}
APP_GROUP=${APP_GROUP:-ping-app}
APP_DIR=${APP_DIR:-/opt/ping-app}
DATA_DIR=${DATA_DIR:-/var/lib/ping-app}
ETC_DIR=${ETC_DIR:-/etc/ping-app}
PY=${PYTHON:-python3}

if [[ $EUID -ne 0 ]]; then
  echo "install.sh must be run as root (try: sudo $0)" >&2
  exit 1
fi

BUNDLE_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "[install] bundle dir : $BUNDLE_DIR"
echo "[install] app dir    : $APP_DIR"
echo "[install] data dir   : $DATA_DIR"
echo "[install] etc dir    : $ETC_DIR"
echo

# ---------------- preconditions ---------------------------------------------

command -v "$PY" >/dev/null || { echo "python3 not found"; exit 1; }
PY_VER=$($PY -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')

# Stock Debian/Ubuntu server images ship python3 WITHOUT the venv/ensurepip
# modules (separate python3-venv package). On an air-gapped box that cannot be
# apt-installed, so fail fast with an actionable message instead of a cryptic
# ensurepip traceback at venv-creation time.
if ! "$PY" -c 'import ensurepip' >/dev/null 2>&1 || ! "$PY" -m venv --help >/dev/null 2>&1; then
  echo "Python venv support missing: '$PY' cannot import ensurepip / run -m venv." >&2
  echo "Install the python3-venv package (e.g. apt install python3-venv) on the" >&2
  echo "target BEFORE going offline — it is a hard prerequisite of this installer." >&2
  exit 1
fi

# Bundle ships CPython wheels for one Python version (see tools/build_bundle.sh
# --python-version, default 3.11). Mismatch = pip will refuse to install the
# wheels with --no-index → silent install failure. We derive the bundle's
# target from the wheel tags: extract every cp3<minor> tag and take the
# numeric MAX. Rationale: non-abi3 wheels always carry the exact build-target
# tag; abi3 wheels (e.g. cp310-abi3-...) carry a lower-or-equal tag and
# install fine on newer Pythons — so the highest tag is the true target.
# KEEP IN SYNC: tools/verify_bundle_offline.sh duplicates this exact pipeline.
EXPECTED_PY_MINOR=$(ls "$BUNDLE_DIR/wheels"/*.whl 2>/dev/null \
  | grep -oE 'cp3[0-9]+' | sed -E 's/^cp3//' | sort -un | tail -1 || true)
EXPECTED_PY=""
if [[ -n "$EXPECTED_PY_MINOR" ]]; then
  EXPECTED_PY="3.${EXPECTED_PY_MINOR}"
fi
if [[ -z "$EXPECTED_PY" ]]; then
  # All-pure bundle — any modern Python works.
  case "$PY_VER" in
    3.11|3.12|3.13) : ;;
    *) echo "Python 3.11+ required (found $PY_VER)"; exit 1 ;;
  esac
elif [[ "$PY_VER" != "$EXPECTED_PY" ]]; then
  echo "Bundle was built for Python $EXPECTED_PY, target has $PY_VER." >&2
  echo "Rebuild bundle on builder: tools/build_bundle.sh --python-version $PY_VER" >&2
  exit 1
fi

[[ -d $BUNDLE_DIR/wheels ]] || { echo "wheels/ missing in bundle — broken archive?"; exit 1; }
[[ -d $BUNDLE_DIR/src ]] || { echo "src/ missing in bundle"; exit 1; }
[[ -d $BUNDLE_DIR/static ]] || { echo "static/ missing in bundle"; exit 1; }

# ---------------- user/group ------------------------------------------------

if ! getent group "$APP_GROUP" >/dev/null; then
  groupadd --system "$APP_GROUP"
  echo "[install] created group $APP_GROUP"
fi
if ! getent passwd "$APP_USER" >/dev/null; then
  useradd --system --gid "$APP_GROUP" --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
  echo "[install] created user  $APP_USER"
fi

# ---------------- paths -----------------------------------------------------

install -d -o root      -g root      -m 0755 "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_GROUP" -m 0750 "$DATA_DIR"
install -d -o root      -g root      -m 0755 "$ETC_DIR"

# ---------------- sync code -------------------------------------------------

# rsync if available, otherwise cp -a. We don't ship rsync as a dependency.
copy() {
  if command -v rsync >/dev/null; then
    rsync -a --delete "$1/" "$2/"
  else
    rm -rf "$2"
    cp -a "$1" "$2"
  fi
}

copy "$BUNDLE_DIR/src"    "$APP_DIR/src"
copy "$BUNDLE_DIR/static" "$APP_DIR/static"
install -m 0644 "$BUNDLE_DIR/requirements.txt" "$APP_DIR/requirements.txt"

# Re-establish the root-owned-code invariant regardless of prior installer or
# builder umask: installs done by the OLD installer chowned APP_DIR to the
# service user, and rsync/cp -a can preserve restrictive modes from the
# builder. Root ownership + world-readability here; DATA_DIR is chowned to
# the service user further below — that chown MUST stay after this block.
chown -R root:root "$APP_DIR"
chmod -R u=rwX,go=rX "$APP_DIR"

# ---------------- venv ------------------------------------------------------

VENV="$APP_DIR/.venv"
# Stale-ABI guard: a venv left behind by a previous install with a different
# Python MINOR (e.g. OS upgrade 3.11→3.12) has broken compiled deps. Compare
# minor versions only — patch-level upgrades (3.11.8→3.11.9) keep the ABI and
# must NOT force a rebuild. A broken/missing venv python yields "" → rebuild.
if [[ -d $VENV ]]; then
  VENV_PY_VER=$("$VENV/bin/python" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null || true)
  if [[ "$VENV_PY_VER" != "$PY_VER" ]]; then
    echo "[install] venv Python (${VENV_PY_VER:-broken}) != target Python ($PY_VER) — recreating venv"
    rm -rf "$VENV"
  fi
fi
if [[ ! -d $VENV ]]; then
  $PY -m venv "$VENV"
  echo "[install] created venv  $VENV"
fi

# Use the venv's bundled pip directly; do NOT --upgrade pip from the offline
# wheels (pip itself is not in the bundle and the earlier `|| true` would mask
# a real failure — Final audit B1).
# --require-hashes: requirements.txt is compiled with --generate-hashes, so
# every wheel in the bundle must match its locked sha256.
"$VENV/bin/pip" install --no-index --require-hashes \
  --find-links "$BUNDLE_DIR/wheels" --upgrade \
  -r "$APP_DIR/requirements.txt"

# ---------------- env file --------------------------------------------------

if [[ ! -f $ETC_DIR/env ]]; then
  install -m 0640 -o root -g "$APP_GROUP" "$BUNDLE_DIR/deploy/env.example" "$ETC_DIR/env"
  echo "[install] wrote env     $ETC_DIR/env  (review + edit if needed)"
else
  echo "[install] keeping existing $ETC_DIR/env (compare with deploy/env.example for new keys)"
fi

# ---------------- systemd unit ---------------------------------------------

install -m 0644 "$BUNDLE_DIR/deploy/ping-app.service" /etc/systemd/system/ping-app.service
systemctl daemon-reload
systemctl enable ping-app.service
# Only the data dir belongs to the service user. Code + venv stay root-owned
# (0755) so a compromised service cannot rewrite its own code.
chown -R "$APP_USER:$APP_GROUP" "$DATA_DIR"

if systemctl is-active --quiet ping-app.service; then
  systemctl restart ping-app.service
  echo "[install] restarted ping-app.service"
else
  systemctl start ping-app.service
  echo "[install] started   ping-app.service"
fi

sleep 1
systemctl status --no-pager ping-app.service | head -10 || true

cat <<EOF

[install] done.

  Logs:    journalctl -u ping-app -f
  Status:  systemctl status ping-app
  URL:     http://\$(hostname -I | awk '{print \$1}'):\${PING_PORT:-8000}/

  Data:    $DATA_DIR/ping.db   (back this up)
  Env:     $ETC_DIR/env        (edit + systemctl restart ping-app)

EOF
