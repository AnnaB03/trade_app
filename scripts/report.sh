#!/bin/bash
# Read-only Cockpit report for the chat check-ins. The Mac schedule (launchd)
# does the trading; this only looks. dryRun=true on both routes.
cd ~/Documents/GitHub/trade_app || exit 1
echo "$(date '+%H:%M ET') server $(curl -s -o /dev/null -w '%{http_code}' --max-time 15 localhost:3000/) health $(curl -s -o /dev/null -w '%{http_code}' --max-time 30 localhost:3000/api/health)"
curl -s --max-time 100 "localhost:3000/api/order/autoexit?dryRun=true${EOD:+&eod=true}" > /tmp/ax.json
curl -s --max-time 150 "localhost:3000/api/order/autotrade?dryRun=true" > /tmp/at.json
curl -s "localhost:3000/api/journal?force=true" > /tmp/j.json
python3 scripts/book.py /tmp/ax.json /tmp/at.json /tmp/j.json | sed '/^autoexit closed/d'
python3 - <<'PY'
import json,datetime
j=json.load(open('/tmp/j.json'))['entries']; today=datetime.date.today().isoformat()
print("TODAY'S TRADES:")
for x in sorted(j,key=lambda x:x.get('entryAt') or x['createdAt']):
    if (x.get('entryAt') or x['createdAt'])[:10]==today or (x.get('exitAt') or '')[:10]==today:
        print(f"  {x['symbol']:5} {(x.get('occ') or 'shares')[-15:]:15} {x.get('strategy') or 'ai':10} {x['status']:8} x{x.get('entryQuantity')} {x.get('entryFillPrice')}->{x.get('exitFillPrice')} pnl {round(x['pnl']) if isinstance(x.get('pnl'),(int,float)) else '-'} {x.get('exitReasonTag') or ''}")
at=json.load(open('/tmp/at.json'))
w=[r for r in at.get('results',[]) if 'Not triggered' in str(r.get('reason')) or r.get('wouldPlace') or r.get('watchOnly')]
print("WAITING / WOULD PLACE:", "; ".join(f"{r['symbol']} {r.get('action')} {r.get('playbook') or 'swing'}: {str(r.get('reason') or 'would place')[:70]}" for r in w[:8]) or "none")
PY
curl -s localhost:3000/api/account | python3 -c "import json,sys; a=json.load(sys.stdin); print('ACCOUNT equity', round(a['equity']), '| can buy', round(a['available']), '| day-trade rule ok', a['pdt']['ok'])"
curl -s localhost:3000/api/halt | python3 -c "import json,sys; d=json.load(sys.stdin); print('TODAY realized', round(d['day']['realized']), '| halted', d['halted'], d.get('reason') or '')"
python3 scripts/shadow-report.py "$(date +%F)" | tail -4
grep "$(date +%F)" ~/Library/Logs/cockpit-autopilot.log | tail -5
