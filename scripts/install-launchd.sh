#!/bin/bash
# Install (or remove) the Cockpit schedule as a macOS LaunchAgent.
#
#   scripts/install-launchd.sh             # show status
#   scripts/install-launchd.sh --install
#   scripts/install-launchd.sh --remove
#
# launchd, not cron: writing a crontab on this Mac hangs on a privacy prompt,
# and the crontab installed on 2026-10-05 pointed into ~/Documents, which macOS
# will not let a background job read, so it never ran once. A LaunchAgent needs
# no such permission as long as everything it touches is outside ~/Documents:
# the scripts are copied to ~/.cockpit and talk to the app over localhost.
#
# The dev server still has to be running (npm run dev) for a tick to do anything.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.cockpit"
LABEL="com.cockpit.autopilot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ACCT="$(grep -E '^ACCOUNT_SIZE=' "$HERE/../.env.local" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
ACCT="${ACCT:-10000}"

case "${1:-}" in
  --install)
    mkdir -p "$DEST" "$HOME/Library/LaunchAgents"
    cp "$HERE/cockpit-cron.sh" "$HERE/cockpit-tick.sh" "$HERE/summarize.py" "$DEST/"
    chmod +x "$DEST/cockpit-cron.sh" "$DEST/cockpit-tick.sh"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DEST/cockpit-tick.sh</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>ACCOUNT_SIZE</key><string>$ACCT</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
  </dict>
  <key>StandardErrorPath</key><string>$DEST/launchd.err</string>
  <key>StandardOutPath</key><string>$DEST/launchd.out</string>
</dict></plist>
PL
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "installed $LABEL (account \$$ACCT). Log: ~/Library/Logs/cockpit-autopilot.log"
    ;;
  --remove)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed."
    ;;
  *)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|runs|last exit" || echo "not installed (run with --install)"
    ;;
esac
