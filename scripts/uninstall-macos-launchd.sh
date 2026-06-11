#!/usr/bin/env bash
set -euo pipefail

LABEL="${PING_LAUNCHD_LABEL:-com.vava.ping-me}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "Uninstalled $LABEL"
