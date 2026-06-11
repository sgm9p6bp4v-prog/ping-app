#!/usr/bin/env bash
set -euo pipefail

LOCAL_NAME="${PING_LOCAL_NAME:-pingme}"
APP_PORT="${PING_PORT:-8000}"
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
  exec sudo PING_LOCAL_NAME="$LOCAL_NAME" PING_PORT="$APP_PORT" "$0" "$@"
fi

mkdir -p "$SUPPORT_DIR"

if [ ! -f "$SUPPORT_DIR/previous-local-hostname" ]; then
  scutil --get LocalHostName > "$SUPPORT_DIR/previous-local-hostname" 2>/dev/null || true
fi

scutil --set LocalHostName "$LOCAL_NAME"
scutil --set ComputerName "$LOCAL_NAME"
scutil --set HostName "$LOCAL_NAME.local"

cat > "$ANCHOR_FILE" <<EOF
rdr pass inet proto tcp from any to self port 80 -> 127.0.0.1 port $APP_PORT
EOF

cat > "$LOADER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
/sbin/pfctl -a com.apple/$LABEL -f "$ANCHOR_FILE"
/sbin/pfctl -E >/dev/null 2>&1 || true
EOF
chmod 0755 "$LOADER"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$LOADER</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF
chmod 0644 "$PLIST"

"$LOADER"
launchctl bootout system "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap system "$PLIST"
launchctl kickstart -k "system/$LABEL" >/dev/null 2>&1 || true
dscacheutil -flushcache >/dev/null 2>&1 || true

cat <<EOF
Installed local URL:

  http://$LOCAL_NAME.local/

Keep ping.me itself running on port $APP_PORT.
EOF
