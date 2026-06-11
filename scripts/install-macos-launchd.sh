#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${PING_LAUNCHD_LABEL:-com.vava.ping-me}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="${PING_LOG_DIR:-$HOME/Library/Logs/ping.me}"
BIND_HOST="${PING_BIND_HOST:-0.0.0.0}"
PORT="${PING_PORT:-8000}"
DATA_DIR="${PING_DATA_DIR:-$HOME/Library/Application Support/ping.me}"
APP_HOME="${PING_APP_HOME:-$HOME/Library/Application Support/ping.me/app}"

mkdir -p "$(dirname "$PLIST")" "$LOG_DIR" "$DATA_DIR" "$APP_HOME"

rsync -a --delete --exclude ".venv/" --exclude "data/" --exclude "dist/" \
  --exclude ".git/" --exclude "__pycache__/" --exclude "*.pyc" \
  "$SOURCE_ROOT/src" "$SOURCE_ROOT/static" "$SOURCE_ROOT/scripts" \
  "$SOURCE_ROOT/requirements.txt" "$SOURCE_ROOT/pyproject.toml" "$SOURCE_ROOT/LICENSE" \
  "$APP_HOME/"

if [ -x "$SOURCE_ROOT/.venv/bin/python" ]; then
  rsync -a --delete "$SOURCE_ROOT/.venv/" "$APP_HOME/.venv/"
fi

chmod +x "$APP_HOME/scripts/run-macos.sh"

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
    <string>$APP_HOME/scripts/run-macos.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$APP_HOME</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PING_BIND_HOST</key>
    <string>$BIND_HOST</string>
    <key>PING_PORT</key>
    <string>$PORT</string>
    <key>PING_DATA_DIR</key>
    <string>$DATA_DIR</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/ping-me.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/ping-me.err.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$UID/$LABEL" >/dev/null 2>&1 || true

echo "Installed $LABEL"
echo "URL: http://$BIND_HOST:$PORT/"
echo "App copy: $APP_HOME"
echo "Logs: $LOG_DIR"
echo "Plist: $PLIST"
