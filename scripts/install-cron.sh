#!/bin/bash
# Install (or remove) the durable Cockpit schedule in the user's crontab.
#
#   scripts/install-cron.sh            # show what would be installed
#   scripts/install-cron.sh --install
#   scripts/install-cron.sh --remove
#
# Times are this machine's local clock. Set COCKPIT_TZ_OFFSET if the machine is
# not on US Eastern; the hours below assume ET.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/cockpit-cron.sh"
MARK="# cockpit-autopilot"

read -r -d '' BLOCK <<CRON || true
$MARK (managed by scripts/install-cron.sh — do not edit by hand)
# Exits every minute while the session is open. The trail's levels were right
# and its cadence was not: SPCX went +8% to -5% between two 15-minute checks.
# Quotes only, no AI cost. The script exits immediately unless the market is open.
*/1 9-15 * * 1-5 $RUN exits
# End-of-day dollar bar in the last hour (the only automated rule that earns).
*/5 15 * * 1-5 $RUN eod
# Entries every 15 minutes.
3,18,33,48 9-15 * * 1-5 $RUN entries
# The one billed call, hourly, plus a pre-open run so the 9:30 window has ideas.
21 9 * * 1-5 $RUN refresh
47 9-14 * * 1-5 $RUN refresh
$MARK end
CRON

case "${1:-}" in
  --install)
    current=$(crontab -l 2>/dev/null || true)
    cleaned=$(printf '%s\n' "$current" | sed "/$MARK/,/$MARK end/d")
    printf '%s\n%s\n' "$cleaned" "$BLOCK" | sed '/^$/N;/^\n$/D' | crontab -
    echo "installed:"; crontab -l | sed -n "/$MARK/,/$MARK end/p"
    ;;
  --remove)
    crontab -l 2>/dev/null | sed "/$MARK/,/$MARK end/d" | crontab - || true
    echo "removed."
    ;;
  *)
    echo "would install (run with --install):"; echo; printf '%s\n' "$BLOCK"
    echo; echo "logs: \${COCKPIT_LOG:-\$HOME/Library/Logs/cockpit-autopilot.log}"
    echo "NOTE: the dev server must be running for any of this to do anything."
    ;;
esac
