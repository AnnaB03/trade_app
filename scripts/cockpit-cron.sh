#!/bin/bash
# Durable Cockpit autopilot — runs from the system crontab, not a Claude session.
#
# Why this exists: every scheduled job lived inside one Claude session, as a
# session-only cron with a 7-day life. When that session ended, nothing managed
# open positions: no exits, no entries, no reconciliation. One job (watchlist
# maintenance) had already silently disappeared. This script is the part that
# must keep running whether or not anyone is watching.
#
# It does NOT report into chat — it logs. Chat reporting stays with the session
# jobs while they exist. The point here is that the orders keep being managed.
#
# Install:  scripts/install-cron.sh
# Logs:     ~/Library/Logs/cockpit-autopilot.log
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${COCKPIT_BASE:-http://localhost:3000}"
LOG="${COCKPIT_LOG:-$HOME/Library/Logs/cockpit-autopilot.log}"
mkdir -p "$(dirname "$LOG")"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(ts) $*" >> "$LOG"; }

# Only trade while the regular session is open. The broker's own clock decides,
# not this machine's, so holidays and half-days need no special casing here.
state=$(curl -s --max-time 15 "$BASE/api/clock" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("clock") or {}).get("state","unknown"))' 2>/dev/null || echo unreachable)
if [ "$state" != "open" ]; then
  [ "${1:-}" = "refresh" ] && log "skip refresh — market $state"
  exit 0
fi

# Health first. A 503 here is the difference between a quiet market and a dead
# autopilot, which is exactly what went unnoticed before.
hc=$(curl -s -o /tmp/cockpit-health.json -w '%{http_code}' --max-time 30 "$BASE/api/health")
if [ "$hc" != "200" ]; then
  log "UNHEALTHY http=$hc $(head -c 400 /tmp/cockpit-health.json 2>/dev/null)"
  exit 1
fi

run() { # run <label> <url>
  local label="$1" url="$2" code summary
  code=$(curl -s -o "/tmp/cockpit-$label.json" -w '%{http_code}' --max-time 120 "$url")
  summary=$(python3 "$HERE/summarize.py" "/tmp/cockpit-$label.json")
  if [ "$code" != "200" ]; then
    log "$label http=$code $summary"
  elif [ -n "$summary" ]; then
    log "$label $summary"
  fi
}

case "${1:-exits}" in
  exits)
    # Every minute. The trail was being defeated by cadence, not by its levels:
    # SPCX went +8% to -5% between two 15-minute checks (-$550), and +$632 to
    # -$138 in another. Quotes only, no AI cost.
    run autoexit "$BASE/api/order/autoexit" ;;
  eod)
    run autoexit-eod "$BASE/api/order/autoexit?eod=true&eodMin=200" ;;
  entries)
    run autotrade "$BASE/api/order/autotrade" ;;
  refresh)
    # The only billed call. Hourly.
    code=$(curl -s -o /tmp/cockpit-sugg.json -w '%{http_code}' --max-time 300 \
      "$BASE/api/suggestions?symbols=NVDA,TSLA,AAL,NOK,FEIM,QQQ,SPY&account=${ACCOUNT_SIZE:-99000}")
    log "refresh http=$code $(python3 "$HERE/summarize.py" /tmp/cockpit-sugg.json)" ;;
  *) log "unknown mode ${1:-}"; exit 2 ;;
esac
