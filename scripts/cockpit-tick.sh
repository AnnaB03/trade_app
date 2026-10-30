#!/bin/bash
# One tick of the Cockpit schedule. launchd runs this about every 60 seconds; it
# looks at the New York clock and decides what is due. Installed to ~/.cockpit by
# scripts/install-launchd.sh — it must not live under ~/Documents, which macOS
# will not let a background job read.
#
#   exits    every tick, 9:30-15:59 (with the end-of-day rules every 5 min in the last hour)
#   entries  every tick, all playbooks
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
# Hold the Mac awake through the session. On 2026-10-09 and 2026-10-12 it
# dozed two minutes in every fifteen all day: half the refreshes were cut off
# mid-call and open positions went unchecked for a quarter of an hour at a
# time. Each tick renews a short hold, so it lapses by itself after the close.
# It cannot WAKE a sleeping Mac or keep a closed lid awake — the lid has to be
# open at 9:00.
# 8:40-17:00 since 2026-10-14: the agent team's brief runs at 8:45 and its
# after-close reports until about 17:00.
if [ "$now" -ge $((8 * 60 + 40)) ] && [ "$now" -lt $((17 * 60)) ]; then
  /usr/bin/caffeinate -is -t 150 >/dev/null 2>&1 &
fi
# The agent team (app/api/agentsLib.js): the server decides what is due (the
# 8:45 brief, 12:30 midday, a read after each big release, QA at 16:20, the
# performance report at 16:35) and starts it. Read-only agents; they report.
# Asked until midnight (2026-10-22), so a run missed while the Mac slept
# catches up when it wakes.
if [ "$now" -ge $((8 * 60 + 40)) ]; then
  ( r=$(curl -s -m 30 "http://localhost:3000/api/agents?tick=1"); case "$r" in *'"started":["'*) echo "$(date '+%F %T') agents $r" >> "$HOME/Library/Logs/cockpit-autopilot.log";; esac ) &
fi
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
# The stop profiles, once a day before the open (9:20-9:29).
if due swing 9 $((9 * 60 + 20)); then nohup "$RUN" swing >/dev/null 2>&1 & fi

[ "$now" -ge $((9 * 60 + 30)) ] || exit 0
# The trend-day read (trendDayLib.js, information only): recorded every tick so
# its 10:30/11:00/12:00 reads and the 15:59 close are kept. Detached; quotes only.
( curl -s -m 20 "http://localhost:3000/api/trendday" >/dev/null 2>&1 ) &
if due eod 3 $eod_slots; then "$RUN" eod; else "$RUN" exits; fi
# The full entry check runs both playbooks; in between, same-day ideas get
# their own look every tick until 15:00, after which none are opened.
# Every tick, all three playbooks. It was every 15 minutes for the multi-day
# ideas, and the best hour of the day paid for that: of 136 directional ideas
# written in the 9am hour, 9 were ever filled. Quotes only, no AI cost.
# Detached, behind a lock (2026-10-22): launchd never starts a tick while the
# last one is still running, so a slow entry check used to delay the next
# minute's EXIT check too. On 10-20 the exit checks stopped for 7+ minutes.
# Exits stay in the foreground, every tick; entries skip a tick rather than
# pile up. A lock older than 10 minutes is a crashed run and is cleared.
LOCK="$STATE/entries.lock"
find "$LOCK" -maxdepth 0 -mmin +10 -exec rmdir {} \; 2>/dev/null
if mkdir "$LOCK" 2>/dev/null; then
  ( "$RUN" entries; rmdir "$LOCK" ) >/dev/null 2>&1 &
fi
exit 0
