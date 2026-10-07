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
# cron runs OUTSIDE the repo, from ~/.cockpit. macOS privacy protection stops
# background processes such as cron from executing or reading anything under
# ~/Documents ("Operation not permitted"), and the repo lives there. The
# autopilot installed on 2026-10-05 therefore never ran a single check: cron
# mailed the same error every minute until it was found on 2026-10-07. The
# script only needs the app's localhost API, /tmp and its own helper, so it is
# copied to a folder cron may use, and ACCOUNT_SIZE is baked in here instead of
# being read back out of the repo's .env.local at run time.
DEST="$HOME/.cockpit"
RUN="$DEST/cockpit-cron.sh"
ACCT=$(grep -E '^ACCOUNT_SIZE=' "$HERE/../.env.local" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
ACCT="${ACCT:-10000}"
ENVP="ACCOUNT_SIZE=$ACCT"
MARK="# cockpit-autopilot"

read -r -d '' BLOCK <<CRON || true
$MARK (managed by scripts/install-cron.sh — do not edit by hand)
# Exits every minute while the session is open. The trail's levels were right
# and its cadence was not: SPCX went +8% to -5% between two 15-minute checks.
# Quotes only, no AI cost. The script exits immediately unless the market is open.
*/1 9-15 * * 1-5 $ENVP $RUN exits
# End-of-day dollar bar in the last hour (the only automated rule that earns).
*/5 15 * * 1-5 $ENVP $RUN eod
# Entries every 15 minutes.
3,18,33,48 9-15 * * 1-5 $ENVP $RUN entries
# The one billed call, every 30 minutes (was hourly until 2026-10-06; an experiment
# to see whether more refreshes mean more positions). Placed at :12 and :42 so each
# finishes before the entry checks at :18 and :48 that would act on its ideas — the
# old :47 refresh landed just AFTER the :48 check and waited a further 15 minutes.
# 9:21 is the pre-open run so the 9:33 window has ideas; 9:42 feeds the 9:48 check.
21 9 * * 1-5 $ENVP $RUN refresh
42 9 * * 1-5 $ENVP $RUN refresh
12,42 10-14 * * 1-5 $ENVP $RUN refresh
$MARK end
CRON

case "${1:-}" in
  --install)
    mkdir -p "$DEST"
    cp "$HERE/cockpit-cron.sh" "$HERE/summarize.py" "$DEST/"
    chmod +x "$DEST/cockpit-cron.sh"
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
