#!/usr/bin/env bash
# NetPing Dashboard — air-gapped installer.
#
# Run on the target Linux server as root from inside the unpacked bundle
# directory (the one containing this script). Idempotent: re-running upgrades
# in place without touching /var/lib/ping-app data.
#
# Tested matrix: Debian 12 / Ubuntu 22.04, 24.04. Python 3.11+.

set -euo pipefail

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
case "$PY_VER" in
  3.11|3.12|3.13) : ;;
  *) echo "Python 3.11+ required (found $PY_VER)"; exit 1 ;;
esac

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

# ---------------- venv ------------------------------------------------------

VENV="$APP_DIR/.venv"
if [[ ! -d $VENV ]]; then
  $PY -m venv "$VENV"
  echo "[install] created venv  $VENV"
fi

# Use the venv's bundled pip directly; do NOT --upgrade pip from the offline
# wheels (pip itself is not in the bundle and the earlier `|| true` would mask
# a real failure — Final audit B1).
"$VENV/bin/pip" install --no-index --find-links "$BUNDLE_DIR/wheels" --upgrade \
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
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR" "$DATA_DIR"

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
