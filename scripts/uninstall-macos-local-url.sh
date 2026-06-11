#!/usr/bin/env bash
set -euo pipefail

LABEL="com.vava.pingme.local-url"
SUPPORT_DIR="/Library/Application Support/ping.me"
ANCHOR_FILE="/etc/pf.anchors/$LABEL"
LOADER="$SUPPORT_DIR/load-local-url.sh"
PLIST="/Library/LaunchDaemons/$LABEL.plist"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This helper is only for macOS." >&2
  exit 1
fi

if [ "$EUID" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

launchctl bootout system "$PLIST" >/dev/null 2>&1 || true
printf "\n" | /sbin/pfctl -a "com.apple/$LABEL" -f - >/dev/null 2>&1 || true

rm -f "$PLIST" "$ANCHOR_FILE" "$LOADER"
dscacheutil -flushcache >/dev/null 2>&1 || true

cat <<EOF
Removed pingme.local port forwarding.

The Mac LocalHostName was left unchanged. To change it manually:

  sudo scutil --set LocalHostName <name>
EOF
