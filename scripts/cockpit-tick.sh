#!/bin/bash
# One tick of the Cockpit schedule. launchd runs this every 60 seconds; it looks
# at the New York clock and decides what is due. Installed to ~/.cockpit by
# scripts/install-launchd.sh — it must not live under ~/Documents, which macOS
# will not let a background job read.
#
#   exits    every minute, 9:30-15:59 (with the end-of-day rules every 5 min in the last hour)
#   entries  at :03 :18 :33 :48
#   refresh  9:21, 9:42, then :12 and :42 from 10:00 to 14:59 (the one billed call)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/cockpit-cron.sh"
export TZ=America/New_York
dow=$(date +%u); h=$((10#$(date +%H))); m=$((10#$(date +%M)))
[ "$dow" -le 5 ] || exit 0
hm=$((h * 100 + m))
[ "$hm" -ge 920 ] && [ "$hm" -lt 1600 ] || exit 0

# The refresh takes one to five minutes. Run it detached so the next minute's
# exit check is not waiting behind it.
if { [ "$hm" -eq 921 ] || [ "$hm" -eq 942 ]; } || { [ "$h" -ge 10 ] && [ "$h" -le 14 ] && { [ "$m" -eq 12 ] || [ "$m" -eq 42 ]; }; }; then
  nohup "$RUN" refresh >/dev/null 2>&1 &
fi

[ "$hm" -ge 930 ] || exit 0
if [ "$h" -eq 15 ] && [ $((m % 5)) -eq 0 ]; then "$RUN" eod; else "$RUN" exits; fi
case "$m" in 3|18|33|48) "$RUN" entries ;; esac
exit 0
