#!/bin/bash
# One tick of the Cockpit schedule. launchd runs this about every 60 seconds; it
# looks at the New York clock and decides what is due. Installed to ~/.cockpit by
# scripts/install-launchd.sh — it must not live under ~/Documents, which macOS
# will not let a background job read.
#
#   exits    every tick, 9:30-15:59 (with the end-of-day rules every 5 min in the last hour)
#   entries  at :03 :18 :33 :48 (same-day ideas: every tick until 15:00)
#   refresh  9:21, 9:42, then :12 and :42 from 10:00 to 14:59 (the one billed call)
#
# Timed jobs are matched to a SLOT, not to the exact minute. launchd's interval
# drifts and skips: on 2026-10-08 it ran 27 times in 29 minutes, no tick landed
# inside 12:12, and that refresh silently never happened. A job now runs on the
# first tick at or after its slot, once, as long as it is not too late to be
# worth doing.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/cockpit-cron.sh"
STATE="$HERE/state"; mkdir -p "$STATE"
export TZ=America/New_York
dow=$(date +%u); h=$((10#$(date +%H))); m=$((10#$(date +%M))); day=$(date +%F)
[ "$dow" -le 5 ] || exit 0
now=$((h * 60 + m))
[ "$now" -ge $((9 * 60 + 20)) ] && [ "$now" -lt $((16 * 60)) ] || exit 0

# due <name> <grace-minutes> <slot-minute-of-day>...  -> true once per slot
due() {
  local name="$1" grace="$2" best=-1 s; shift 2
  for s in "$@"; do [ "$s" -le "$now" ] && [ "$s" -gt "$best" ] && best="$s"; done
  [ "$best" -ge 0 ] && [ $((now - best)) -le "$grace" ] || return 1
  [ "$(cat "$STATE/$name" 2>/dev/null)" = "$day-$best" ] && return 1
  echo "$day-$best" > "$STATE/$name"
}

refresh_slots="$((9 * 60 + 21)) $((9 * 60 + 42))"
entry_slots=""; eod_slots=""
for hh in 10 11 12 13 14; do refresh_slots="$refresh_slots $((hh * 60 + 12)) $((hh * 60 + 42))"; done
for hh in 9 10 11 12 13 14 15; do for mm in 3 18 33 48; do [ $((hh * 60 + mm)) -ge $((9 * 60 + 33)) ] && entry_slots="$entry_slots $((hh * 60 + mm))"; done; done
for mm in 0 5 10 15 20 25 30 35 40 45 50 55; do eod_slots="$eod_slots $((15 * 60 + mm))"; done

# The refresh takes one to five minutes. Run it detached so the next tick's exit
# check is not waiting behind it. A refresh up to 20 minutes late still beats
# none: the next one is half an hour away.
if due refresh 20 $refresh_slots; then nohup "$RUN" refresh >/dev/null 2>&1 & fi

[ "$now" -ge $((9 * 60 + 30)) ] || exit 0
if due eod 3 $eod_slots; then "$RUN" eod; else "$RUN" exits; fi
# The full entry check runs both playbooks; in between, same-day ideas get
# their own look every tick until 15:00, after which none are opened.
if due entries 6 $entry_slots; then "$RUN" entries
elif [ "$h" -lt 15 ]; then "$RUN" entries-intraday; "$RUN" entries-fade; fi
exit 0
